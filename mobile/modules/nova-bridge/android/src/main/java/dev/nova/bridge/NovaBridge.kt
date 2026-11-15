package dev.nova.bridge

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.telecom.TelecomManager
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * What the notification listener sees, handed to the app's JavaScript (NovaBridgeModule),
 * which forwards it to NOVA on the PC over the encrypted connection. Nothing is stored.
 *
 * Calls are recognized by the phone app's own call notification (CATEGORY_CALL). Answer and
 * decline are offered only when that notification carries Android's call actions (CallStyle,
 * Android 12+) or the user granted ANSWER_PHONE_CALLS; otherwise the PC only shows the call.
 */
object NovaBridge {
  @Volatile var module: NovaBridgeModule? = null
  @Volatile var forwardNotifications = false
  @Volatile var forwardCalls = false
  /** Privacy: send only the app's name, no title or text. */
  @Volatile var onlyAppNames = false
  /** Leave out what Android itself shows without sound or pop-up. */
  @Volatile var skipSilent = true

  /** `shown` is what the PC was last told about this call, to tell a real change from a repost. */
  private class Call(val answer: PendingIntent?, val decline: PendingIntent?, val ringing: Boolean, val shown: Int?)

  private val calls = ConcurrentHashMap<String, Call>()
  /** The content last forwarded per notification key: apps repost the same notification, the PC should see it once. */
  private val forwarded = ConcurrentHashMap<String, Int>()
  private val icons = ConcurrentHashMap<String, String>()
  private val labels = ConcurrentHashMap<String, String>()

  // Android's CallStyle extras (Notification.EXTRA_*, API 31); read by name so older phones work too.
  private const val EXTRA_ANSWER_INTENT = "android.answerIntent"
  private const val EXTRA_DECLINE_INTENT = "android.declineIntent"
  private const val EXTRA_HANG_UP_INTENT = "android.hangUpIntent"
  private const val EXTRA_CALL_TYPE = "android.callType"
  private const val EXTRA_CALL_PERSON = "android.callPerson"
  private const val CALL_TYPE_INCOMING = 1
  private const val CALL_TYPE_ONGOING = 2

  /** `callsOnly` is for notifications that were already there when the listener started: a ringing call matters, old messages don't. */
  fun posted(context: Context, sbn: StatusBarNotification, ranking: NotificationListenerService.RankingMap?, callsOnly: Boolean) {
    if (sbn.packageName == context.packageName) return
    val notification = sbn.notification ?: return
    if (notification.category == Notification.CATEGORY_CALL) {
      call(context, sbn, notification)
      return
    }
    if (callsOnly || !forwardNotifications) return
    // Media players, downloads, navigation and group headers aren't messages.
    if (sbn.isOngoing || notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return
    // Privacy: the app that posted it says it must not be shown where others can see it.
    if (notification.visibility == Notification.VISIBILITY_SECRET) return
    if (skipSilent && silent(sbn.key, ranking)) return
    val extras = notification.extras ?: Bundle.EMPTY
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty().trim()
    val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty().trim()
    if (title.isEmpty() && text.isEmpty()) return
    // Without the app's JavaScript nobody would hear it; remembering it as sent would swallow the repost that could be heard.
    val listener = module ?: return
    val content = 31 * title.hashCode() + text.hashCode()
    if (forwarded.put(sbn.key, content) == content) return
    val private = onlyAppNames
    listener.sendEvent(
      "onNotification",
      mapOf(
        "key" to sbn.key,
        "app" to sbn.packageName,
        "appName" to label(context, sbn.packageName, notification),
        "title" to if (private) "" else title.take(200),
        "text" to if (private) "" else text.take(1000),
        "icon" to appIcon(context, sbn.packageName, notification),
        "posted" to sbn.postTime.toDouble(),
      ),
    )
  }

  /** Whether Android ranks this notification below "default": no sound, no pop-up. */
  private fun silent(key: String, ranking: NotificationListenerService.RankingMap?): Boolean {
    val entry = NotificationListenerService.Ranking()
    if (ranking == null || !ranking.getRanking(key, entry)) return false
    return entry.importance < NotificationManager.IMPORTANCE_DEFAULT
  }

  fun removed(sbn: StatusBarNotification) {
    forwarded.remove(sbn.key)
    if (calls.remove(sbn.key) != null) {
      module?.sendEvent("onCall", mapOf("callId" to sbn.key, "state" to "ended", "name" to null, "number" to null, "photo" to null, "canAnswer" to false, "canDecline" to false))
    }
  }

  private fun pending(extras: Bundle, key: String): PendingIntent? =
    if (Build.VERSION.SDK_INT >= 33) extras.getParcelable(key, PendingIntent::class.java) else @Suppress("DEPRECATION") extras.getParcelable(key)

  private fun call(context: Context, sbn: StatusBarNotification, notification: Notification) {
    if (!forwardCalls) return
    val extras = notification.extras ?: Bundle.EMPTY
    val answer = pending(extras, EXTRA_ANSWER_INTENT)
    val decline = pending(extras, EXTRA_DECLINE_INTENT) ?: pending(extras, EXTRA_HANG_UP_INTENT)
    val type = extras.getInt(EXTRA_CALL_TYPE, 0)
    // Without CallStyle: a full-screen ringing screen means it rings.
    val ringing = type == CALL_TYPE_INCOMING || (type != CALL_TYPE_ONGOING && (answer != null || notification.fullScreenIntent != null))
    val telecom = mayAnswer(context)

    var name = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
    var number: String? = null
    if (Build.VERSION.SDK_INT >= 31) {
      val person: Person? = if (Build.VERSION.SDK_INT >= 33) extras.getParcelable(EXTRA_CALL_PERSON, Person::class.java) else @Suppress("DEPRECATION") extras.getParcelable(EXTRA_CALL_PERSON)
      name = person?.name?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: name
      number = person?.uri?.takeIf { it.startsWith("tel:") }?.removePrefix("tel:")
    }
    if (number == null) {
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
      number = text.takeIf { Regex("^[+\\d][\\d\\s()/-]{2,38}$").matches(it) }
    }
    val canAnswer = ringing && (answer != null || telecom)
    val canDecline = decline != null || (telecom && Build.VERSION.SDK_INT >= 28)
    // Phone apps repost the call notification while nothing changed; the PC needs each state once.
    val shown = listOf(ringing, name, number, canAnswer, canDecline).hashCode()
    val listener = module
    // The call is remembered either way (the PC may ask to answer it); "shown" only once someone heard it.
    val before = calls.put(sbn.key, Call(answer, decline, ringing, if (listener == null) null else shown))
    if (listener == null || before?.shown == shown) return
    listener.sendEvent(
      "onCall",
      mapOf(
        "callId" to sbn.key,
        "state" to if (ringing) "ringing" else "active",
        "name" to name?.take(100),
        "number" to number?.take(40),
        "photo" to callerPhoto(context, notification),
        "canAnswer" to canAnswer,
        "canDecline" to canDecline,
      ),
    )
  }

  fun mayAnswer(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 26 && context.checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED

  /** Answers or declines a call the PC asked about. `false` if this phone can't. */
  @SuppressLint("MissingPermission")
  fun act(context: Context, callId: String, accept: Boolean): Boolean {
    val call = calls[callId] ?: return false
    val intent = if (accept) call.answer else call.decline
    if (intent != null) {
      return try {
        intent.send()
        true
      } catch (_: PendingIntent.CanceledException) {
        false
      }
    }
    if (!mayAnswer(context)) return false
    val telecom = context.getSystemService(TelecomManager::class.java) ?: return false
    return try {
      when {
        accept && call.ringing -> {
          @Suppress("DEPRECATION") telecom.acceptRingingCall()
          true
        }
        !accept && Build.VERSION.SDK_INT >= 28 -> @Suppress("DEPRECATION") telecom.endCall()
        else -> false
      }
    } catch (_: SecurityException) {
      false
    }
  }

  /** Calls ringing or running right now, for a PC that connects in the middle of one. */
  fun activeCalls(): List<Map<String, Any?>> = calls.map { (key, call) -> mapOf("callId" to key, "ringing" to call.ringing) }

  // ---------------------------------------------------------------------------
  // Names and pictures, small
  // ---------------------------------------------------------------------------

  /** The app's name; through the notification's ApplicationInfo first, which works for apps Android hides from this one. */
  private fun label(context: Context, packageName: String, notification: Notification): String {
    labels[packageName]?.let { return it }
    val pm = context.packageManager
    val name = try {
      notificationAppInfo(notification)?.takeIf { it.packageName == packageName }?.loadLabel(pm)?.toString()?.trim()?.takeIf { it.isNotEmpty() && it != packageName }
    } catch (_: Exception) {
      null
    } ?: try {
      pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (_: Exception) {
      null
    }
    // A guess from the package name isn't remembered: the real name may be readable next time.
    return name?.take(100)?.also { labels[packageName] = it } ?: packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }.take(100)
  }

  /**
   * The app's launcher icon as base64 PNG or WebP (the PC accepts only these two, at most
   * 16 000 characters). Found, in this order: through the ApplicationInfo the notification
   * carries (needs no package visibility, so it also works for apps Android 11+ hides from
   * this one), through the package manager, and as the notification's own small icon on a
   * badge of its color. Only a real launcher icon is remembered; a miss is tried again later.
   */
  private fun appIcon(context: Context, packageName: String, notification: Notification): String? {
    icons[packageName]?.let { return it }
    val missedAt = iconMisses[packageName]
    if (missedAt == null || System.currentTimeMillis() - missedAt > ICON_RETRY_MS) {
      val pm = context.packageManager
      val drawable = try {
        notificationAppInfo(notification)?.takeIf { it.packageName == packageName && it.icon != 0 }?.loadIcon(pm)
      } catch (_: Exception) {
        null
      } ?: try {
        pm.getApplicationIcon(packageName)
      } catch (_: Exception) {
        null
      }
      val encoded = drawable?.let { safely { encode(render(it, ICON_PX), ICON_CHARS, webp = true) } }
      if (encoded != null) {
        icons[packageName] = encoded
        iconMisses.remove(packageName)
        return encoded
      }
      iconMisses[packageName] = System.currentTimeMillis()
    }
    return safely { smallIconBadge(context, notification)?.let { encode(it, ICON_CHARS, webp = true) } }
  }

  private const val ICON_PX = 48
  /** Below the PC's 16 000 so a protocol change there never drops a whole notification. */
  private const val ICON_CHARS = 14_000
  private const val ICON_RETRY_MS = 5 * 60_000L
  private val iconMisses = ConcurrentHashMap<String, Long>()

  /** Notification.Builder puts the posting app's ApplicationInfo into the extras ("android.appInfo"). */
  private fun notificationAppInfo(notification: Notification): ApplicationInfo? {
    val extras = notification.extras ?: return null
    return if (Build.VERSION.SDK_INT >= 33) extras.getParcelable("android.appInfo", ApplicationInfo::class.java)
    else @Suppress("DEPRECATION") extras.getParcelable("android.appInfo")
  }

  /** The notification's small (status bar) icon in white on a circle of the app's notification color. */
  private fun smallIconBadge(context: Context, notification: Notification): Bitmap? {
    val glyph = notification.smallIcon?.loadDrawable(context)?.mutate() ?: return null
    val bitmap = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val color = notification.color.takeIf { it != Notification.COLOR_DEFAULT && Color.alpha(it) > 0 } ?: 0xFF5B6170.toInt()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color or 0xFF000000.toInt() }
    canvas.drawCircle(ICON_PX / 2f, ICON_PX / 2f, ICON_PX / 2f, paint)
    val inset = (ICON_PX * 0.22f).toInt()
    glyph.setTint(Color.WHITE)
    glyph.setBounds(inset, inset, ICON_PX - inset, ICON_PX - inset)
    glyph.draw(canvas)
    return bitmap
  }

  private fun callerPhoto(context: Context, notification: Notification): String? {
    val icon: Icon = notification.getLargeIcon() ?: return null
    return safely { encode(render(icon.loadDrawable(context) ?: return@safely null, 96), 22_000, webp = false) }
  }

  private inline fun <T> safely(block: () -> T?): T? =
    try {
      block()
    } catch (_: Exception) {
      null
    } catch (_: OutOfMemoryError) {
      null
    }

  /** A drawable drawn into a `size` px square. */
  private fun render(drawable: Drawable, size: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val source = (drawable as? BitmapDrawable)?.bitmap
    if (source != null && !source.isRecycled) {
      val scaled = Bitmap.createScaledBitmap(source, size, size, true)
      canvas.drawBitmap(scaled, 0f, 0f, null)
      // A source that already has this size comes back as itself and isn't ours to free.
      if (scaled !== source) scaled.recycle()
    } else {
      drawable.setBounds(0, 0, size, size)
      drawable.draw(canvas)
    }
    return bitmap
  }

  /**
   * The bitmap as base64 that fits in `most` characters, or null; frees the bitmap. Lossless
   * PNG first; detailed icons (gradients) can be too large as PNG, so then lossy WebP, and
   * last a smaller PNG.
   */
  private fun encode(bitmap: Bitmap, most: Int, webp: Boolean): String? {
    try {
      fun attempt(image: Bitmap, format: Bitmap.CompressFormat, quality: Int): String? {
        val bytes = ByteArrayOutputStream().use { out ->
          if (!image.compress(format, quality, out)) return null
          out.toByteArray()
        }
        return Base64.encodeToString(bytes, Base64.NO_WRAP).takeIf { it.length <= most }
      }
      attempt(bitmap, Bitmap.CompressFormat.PNG, 100)?.let { return it }
      if (webp) {
        val lossy = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
        for (quality in intArrayOf(90, 75)) attempt(bitmap, lossy, quality)?.let { return it }
      }
      val smaller = Bitmap.createScaledBitmap(bitmap, bitmap.width * 2 / 3, bitmap.height * 2 / 3, true)
      try {
        return attempt(smaller, Bitmap.CompressFormat.PNG, 100)
      } finally {
        if (smaller !== bitmap) smaller.recycle()
      }
    } finally {
      bitmap.recycle()
    }
  }
}
