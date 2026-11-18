package bd.takaledger.agent.service

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import bd.takaledger.agent.crypto.DeviceCryptoStore
import bd.takaledger.agent.data.OfflineQueueDatabase
import bd.takaledger.agent.data.QueuedNotificationEntity
import bd.takaledger.agent.worker.EventSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Read-only NotificationListenerService for bKash, Nagad, Rocket, Upay, CellFin, Bangla QR, and Bank alerts.
 * Strictly blocks OTP/PIN notifications locally before queuing and never automates MFS or Banking UI.
 */
class MfsNotificationListenerService : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val pkg = sbn.packageName ?: return
        if (!WHITELISTED_PACKAGES.contains(pkg)) return

        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        val rawBody = (bigText ?: text ?: "").trim()

        if (rawBody.isBlank()) return

        if (SMS_PACKAGES.contains(pkg) && !containsPaymentKeyword("$title $rawBody")) {
            return
        }

        // Security Guard: Never persist or upload OTP / PIN / verification code messages
        if (OTP_OR_PIN_REGEX.containsMatchIn("$title $rawBody")) {
            return
        }

        val redactedBody = sanitizeBody(rawBody)
        val ts = sbn.postTime
        val eventHash = DeviceCryptoStore.sha256Hex("NOTIF|$pkg|${title.orEmpty()}|$redactedBody|${ts / 1000}")
        val entity = QueuedNotificationEntity(
            eventUid = UUID.randomUUID().toString(),
            eventHash = eventHash,
            packageName = pkg,
            title = title,
            bodyRedacted = redactedBody,
            deviceTimestampMs = ts
        )

        scope.launch {
            val db = OfflineQueueDatabase.getInstance(applicationContext)
            val inserted = db.dao().enqueueIfNew(entity)
            if (inserted != -1L) {
                enqueueImmediateSync()
            }
        }
    }

    private fun enqueueImmediateSync() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val request = OneTimeWorkRequestBuilder<EventSyncWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(applicationContext)
            .enqueueUniqueWork(SYNC_WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    companion object {
        private const val SYNC_WORK_NAME = "takaledger_event_sync"

        private val MFS_AND_BANK_PACKAGES = setOf(
            "com.bKash.customerapp",
            "com.bkash.businessapp",
            "com.bkash.merchant",
            "com.konasl.nagad",
            "com.konasl.nagad.uddokta",
            "com.dbbl.mfs.rocket",
            "com.dbbl.rocket",
            "com.ucb.upay",
            "bd.com.upay.agent",
            "bd.com.upay.merchant",
            "com.ibbl.cellfin",
            "com.islamibank.cellfin",
            "com.citybank.citytouch",
            "com.bracbank.astha",
            "com.dbbl.nexus.pay",
            "com.ebl.skybanking"
        )

        private val SMS_PACKAGES = setOf(
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.mms"
        )

        private val WHITELISTED_PACKAGES = MFS_AND_BANK_PACKAGES + SMS_PACKAGES

        val OTP_OR_PIN_REGEX = Regex(
            """\b(otp|one[\s-]*time[\s-]*password|verification\s*code|pin\s*(?:is|:)|secret\s*code)\b""",
            RegexOption.IGNORE_CASE
        )

        fun containsPaymentKeyword(content: String): Boolean {
            val lower = content.lowercase()
            return lower.contains("bkash") ||
                lower.contains("nagad") ||
                lower.contains("rocket") ||
                lower.contains("upay") ||
                lower.contains("cellfin") ||
                lower.contains("banglaqr") ||
                lower.contains("bangla qr") ||
                lower.contains("credited") ||
                lower.contains("16247") ||
                lower.contains("16167") ||
                lower.contains("16216") ||
                lower.contains("16268")
        }

        fun sanitizeBody(body: String): String {
            return body.replace(
                Regex("""\b(OTP|PIN|Code)\s*[:=-]?\s*\d{4,8}\b""", RegexOption.IGNORE_CASE),
                "$1: [REDACTED]"
            )
        }
    }
}
