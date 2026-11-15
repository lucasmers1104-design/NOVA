package dev.nova.bridge

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

/** The JavaScript side of NovaBridge (modules/nova-bridge/index.ts). */
class NovaBridgeModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("NovaBridge")
    Events("onNotification", "onCall")

    OnCreate { NovaBridge.module = this@NovaBridgeModule }
    OnDestroy { if (NovaBridge.module === this@NovaBridgeModule) NovaBridge.module = null }

    /** Whether the user allowed notification access for this app. */
    Function("hasNotificationAccess") {
      val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
      val mine = ComponentName(context, NovaNotificationListener::class.java)
      enabled.split(':').any { ComponentName.unflattenFromString(it) == mine }
    }

    Function("openNotificationAccess") {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("configure") { notifications: Boolean, calls: Boolean, onlyAppNames: Boolean, skipSilent: Boolean ->
      NovaBridge.forwardNotifications = notifications
      NovaBridge.forwardCalls = calls
      NovaBridge.onlyAppNames = onlyAppNames
      NovaBridge.skipSilent = skipSilent
    }

    /** Whether the app may answer and end calls itself (ANSWER_PHONE_CALLS). */
    Function("mayAnswerCalls") { NovaBridge.mayAnswer(context) }

    AsyncFunction("callAction") { callId: String, action: String ->
      NovaBridge.act(context, callId, action == "accept")
    }

    Function("activeCalls") { NovaBridge.activeCalls() }

    /** Android 8+: whether this app may hand an update to the installer. */
    Function("canInstallUpdates") {
      Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallPermission") {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /**
     * SHA-256 of a downloaded file as lowercase hex, read in pieces: the update is about
     * 40 MB, and hashing it in JavaScript would hold all of it in memory twice.
     */
    AsyncFunction("fileSha256") { uri: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      val input = context.contentResolver.openInputStream(Uri.parse(uri)) ?: throw Exceptions.IllegalArgument("fileSha256 can't open that file")
      input.use { stream ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = stream.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Opens Android's installer for a downloaded APK (a content:// URI from expo-file-system). */
    Function("installApk") { contentUri: String ->
      if (!contentUri.startsWith("content://")) throw Exceptions.IllegalArgument("installApk needs a content:// URI")
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(Uri.parse(contentUri), "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      (appContext.currentActivity ?: context).startActivity(intent)
    }
  }
}
