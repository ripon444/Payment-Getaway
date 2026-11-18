package bd.takaledger.agent.ui

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import bd.takaledger.agent.crypto.DeviceCryptoStore
import bd.takaledger.agent.data.OfflineQueueDatabase
import bd.takaledger.agent.service.MfsNotificationListenerService
import bd.takaledger.agent.worker.EventSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PairingActivity : AppCompatActivity() {

    private val client = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val store = DeviceCryptoStore(this)
        val statusView = TextView(this).apply {
            text = if (store.isPaired()) {
                "Device Paired (${store.getDeviceId()})\nGateway: ${store.getGatewayUrl()}"
            } else {
                "Not Paired — Enter Gateway URL and Pairing Code from Admin Dashboard"
            }
            setPadding(48, 48, 48, 24)
        }

        val urlInput = EditText(this).apply {
            hint = "https://gateway.yourdomain.com"
            setText(store.getGatewayUrl() ?: "")
        }
        val codeInput = EditText(this).apply {
            hint = "Pairing Code (e.g. ABCD-EFGH)"
        }

        val pairBtn = Button(this).apply {
            text = "Pair Android Device"
            setOnClickListener {
                val baseUrl = urlInput.text.toString().trim().trimEnd('/')
                val code = codeInput.text.toString().trim().uppercase()
                if (baseUrl.isNotEmpty() && code.isNotEmpty()) {
                    performPairing(store, baseUrl, code, statusView)
                }
            }
        }

        val permBtn = Button(this).apply {
            text = "Enable Notification Listener Access"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }

        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 64, 48, 48)
            addView(statusView)
            addView(urlInput)
            addView(codeInput)
            addView(pairBtn)
            addView(permBtn)
        }

        setContentView(layout)
        schedulePeriodicSync()
        refreshQueueCount(statusView, store)
    }

    private fun performPairing(
        store: DeviceCryptoStore,
        gatewayUrl: String,
        pairingCode: String,
        statusView: TextView
    ) {
        scope.launch {
            val resultText = withContext(Dispatchers.IO) {
                val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                val payload = JSONObject().apply {
                    put("pairingCode", pairingCode)
                    put("deviceUid", "AND-${androidId.take(10).uppercase()}")
                    put("androidModel", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("androidVersion", "Android ${Build.VERSION.RELEASE}")
                    put("appVersion", "1.4.2")
                }.toString()

                val req = Request.Builder()
                    .url("$gatewayUrl/api/devices/pair")
                    .post(payload.toRequestBody("application/json".toMediaType()))
                    .build()

                try {
                    client.newCall(req).execute().use { res ->
                        val body = res.body?.string().orEmpty()
                        if (!res.isSuccessful) {
                            "Pairing failed (${res.code}): $body"
                        } else {
                            val json = JSONObject(body)
                            store.savePairing(
                                gatewayUrl = gatewayUrl,
                                deviceId = json.getString("deviceId"),
                                deviceToken = json.getString("deviceToken"),
                                hmacSecret = json.getString("hmacSecret")
                            )
                            "Paired successfully as ${json.getString("deviceName")}"
                        }
                    }
                } catch (e: Exception) {
                    "Network error: ${e.message}"
                }
            }
            statusView.text = resultText
        }
    }

    private fun refreshQueueCount(statusView: TextView, store: DeviceCryptoStore) {
        scope.launch {
            val count = withContext(Dispatchers.IO) {
                OfflineQueueDatabase.getInstance(applicationContext).dao().getPendingCount()
            }
            val listenerEnabled = isListenerEnabled()
            statusView.append("\nListener Active: $listenerEnabled | Queued Offline Events: $count")
            if (store.isPaired()) {
                statusView.append("\nSecurity: Keystore AES-256-GCM + HMAC-SHA256 Active")
            }
        }
    }

    private fun isListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val cn = ComponentName(this, MfsNotificationListenerService::class.java).flattenToString()
        return flat.contains(cn)
    }

    private fun schedulePeriodicSync() {
        val work = PeriodicWorkRequestBuilder<EventSyncWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "takaledger_periodic_heartbeat",
            ExistingPeriodicWorkPolicy.KEEP,
            work
        )
    }
}
