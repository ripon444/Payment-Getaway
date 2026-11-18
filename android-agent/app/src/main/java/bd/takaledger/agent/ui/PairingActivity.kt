package bd.takaledger.agent.ui

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
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
                "Status: PAIRED (${store.getDeviceId()})\nGateway: ${store.getGatewayUrl()}"
            } else {
                "Status: NOT PAIRED — Enter Gateway URL & Pairing Code from Admin/Merchant Dashboard"
            }
            setPadding(0, 0, 0, 24)
        }

        val rationaleView = TextView(this).apply {
            text = "Permissions & Security Notice:\n" +
                "• Notification Listener reads incoming payment alerts from bKash, Nagad, Rocket, Upay, CellFin, and Bank apps.\n" +
                "• SMS Access (Optional) captures bank credit & Bangla QR SMS on dual-SIM phones.\n" +
                "• OTP, PIN, and password messages are redacted locally and never uploaded.\n" +
                "• Battery Optimization must be disabled for reliable offline-to-online background sync."
            setPadding(0, 16, 0, 24)
        }

        val urlInput = EditText(this).apply {
            hint = "https://pay.yourdomain.com"
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

        val notifPermBtn = Button(this).apply {
            text = "1. Grant Notification Listener Access"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
        }

        val smsPermBtn = Button(this).apply {
            text = "2. Grant SMS Read Access (Bank / Bangla QR SMS)"
            setOnClickListener {
                if (ContextCompat.checkSelfPermission(this@PairingActivity, Manifest.permission.RECEIVE_SMS)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    ActivityCompat.requestPermissions(
                        this@PairingActivity,
                        arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_PHONE_STATE),
                        101
                    )
                }
            }
        }

        val batteryBtn = Button(this).apply {
            text = "3. Disable Battery Optimization (Recommended)"
            setOnClickListener {
                val pm = getSystemService(POWER_SERVICE) as PowerManager
                if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                }
            }
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 64, 48, 48)
            addView(statusView)
            addView(urlInput)
            addView(codeInput)
            addView(pairBtn)
            addView(rationaleView)
            addView(notifPermBtn)
            addView(smsPermBtn)
            addView(batteryBtn)
        }

        setContentView(ScrollView(this).apply { addView(layout) })
        schedulePeriodicSync()
        refreshDiagnostics(statusView, store)
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
                    put("appVersion", "2.0.0")
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

    private fun refreshDiagnostics(statusView: TextView, store: DeviceCryptoStore) {
        scope.launch {
            val count = withContext(Dispatchers.IO) {
                OfflineQueueDatabase.getInstance(applicationContext).dao().getPendingCount()
            }
            val listenerEnabled = isListenerEnabled()
            val smsGranted = ContextCompat.checkSelfPermission(
                this@PairingActivity,
                Manifest.permission.RECEIVE_SMS
            ) == PackageManager.PERMISSION_GRANTED
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val batteryExempt = pm.isIgnoringBatteryOptimizations(packageName)

            statusView.append(
                "\nListener Active: $listenerEnabled | SMS Granted: $smsGranted" +
                    "\nBattery Unrestricted: $batteryExempt | Queued Offline Events: $count" +
                    if (store.isPaired()) "\nCrypto: Android Keystore AES-256-GCM + HMAC-SHA256" else ""
            )
        }
    }

    private fun isListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val cn = ComponentName(this, MfsNotificationListenerService::class.java).flattenToString()
        return flat.contains(cn)
    }

    private fun schedulePeriodicSync() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val work = PeriodicWorkRequestBuilder<EventSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "takaledger_periodic_heartbeat",
            ExistingPeriodicWorkPolicy.UPDATE,
            work
        )
    }
}
