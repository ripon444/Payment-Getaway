package bd.takaledger.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
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
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Dual-SIM aware BroadcastReceiver for incoming MFS & Bank SMS credit alerts.
 * Strictly drops OTP/PIN messages locally before queueing into encrypted Room SQLite.
 */
class MfsSmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return

        val sender = messages[0].displayOriginatingAddress ?: "SMS"
        val fullBody = messages.joinToString(separator = "") { it.messageBody ?: "" }.trim()
        if (fullBody.isBlank()) return

        if (!MfsNotificationListenerService.containsPaymentKeyword("$sender $fullBody")) {
            return
        }
        if (MfsNotificationListenerService.OTP_OR_PIN_REGEX.containsMatchIn("$sender $fullBody")) {
            return
        }

        val redacted = MfsNotificationListenerService.sanitizeBody(fullBody)
        val ts = messages[0].timestampMillis
        val simSlot = extractSimSlot(intent)
        val hash = DeviceCryptoStore.sha256Hex("SMS|$sender|$redacted|${ts / 1000}")
        val entity = QueuedNotificationEntity(
            eventUid = UUID.randomUUID().toString(),
            eventHash = hash,
            sourceChannel = "SMS",
            packageName = "sms:$sender",
            senderHeader = sender,
            simSlot = simSlot,
            title = "SMS from $sender",
            bodyRedacted = redacted,
            deviceTimestampMs = ts
        )

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val dao = OfflineQueueDatabase.getInstance(context.applicationContext).dao()
                val inserted = dao.enqueueIfNew(entity)
                if (inserted != -1L) {
                    val constraints = Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                    val work = OneTimeWorkRequestBuilder<EventSyncWorker>()
                        .setConstraints(constraints)
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                        .build()
                    WorkManager.getInstance(context.applicationContext)
                        .enqueueUniqueWork("takaledger_event_sync", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun extractSimSlot(intent: Intent): Int? {
        val rawSlot = intent.getIntExtra(
            "android.telephony.extra.SLOT_INDEX",
            intent.getIntExtra("slot", intent.getIntExtra("simSlot", -1))
        )
        return if (rawSlot >= 0) rawSlot + 1 else null
    }
}
