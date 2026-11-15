package dev.nova.bridge

import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Android binds this only after the user turned on notification access for NOVA Companion
 * in the system settings. It hands every posted and removed notification to NovaBridge,
 * which decides what goes to the PC (nothing, unless forwarding is on in the app).
 *
 * Every callback is guarded: this service runs in the app's process, and another app's
 * notification must never be able to crash it. Before Android 13 a notification whose
 * extras hold that app's own Parcelable classes throws as soon as the extras are read.
 */
class NovaNotificationListener : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    guarded("posted") { NovaBridge.posted(this, sbn, currentRanking, false) }
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {
    guarded("removed") { NovaBridge.removed(sbn) }
  }

  /** A call that already rings when the listener starts should still reach the PC. Only calls: old notifications are no news. */
  override fun onListenerConnected() {
    guarded("connected") {
      val ranking = currentRanking
      for (sbn in activeNotifications ?: emptyArray()) NovaBridge.posted(this, sbn, ranking, true)
    }
  }

  /** Android dropped the binding (it does under memory pressure): ask for it back instead of staying deaf until a restart. */
  override fun onListenerDisconnected() {
    guarded("disconnected") { NotificationListenerService.requestRebind(ComponentName(this, NovaNotificationListener::class.java)) }
  }

  private inline fun guarded(what: String, block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      // Only the kind of failure: a message could quote the notification.
      Log.w("NovaBridge", "notification $what failed: ${e.javaClass.simpleName}")
    }
  }
}
