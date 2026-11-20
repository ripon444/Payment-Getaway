package bd.takaledger.agent.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.ActivityResultLauncher
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import bd.takaledger.agent.BuildConfig
import bd.takaledger.agent.crypto.DeviceCryptoStore
import bd.takaledger.agent.data.OfflineQueueDatabase
import bd.takaledger.agent.service.MfsNotificationListenerService
import bd.takaledger.agent.worker.EventSyncWorker
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PairingActivity : AppCompatActivity() {

    private val client = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.Main)

    private lateinit var store: DeviceCryptoStore
    private lateinit var statusView: TextView
    private lateinit var urlInput: EditText
    private lateinit var codeInput: EditText

    private val qrLauncher: ActivityResultLauncher<ScanOptions> =
        registerForActivityResult(ScanContract()) { result ->
            val raw = result.contents ?: return@registerForActivityResult
            handleQrPayload(raw)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        store = DeviceCryptoStore(this)
        statusView = TextView(this).apply {
            setPadding(0, 0, 0, 24)
        }

        urlInput = EditText(this).apply {
            hint = "Gateway URL (e.g. https://pay.takaledger.bd)"
            setText(store.getGatewayUrl() ?: "")
        }
        codeInput = EditText(this).apply {
            hint = "Pairing Code (e.g. ABCD-EFGH)"
        }

        val scanQrBtn = Button(this).apply {
            text = "Scan Dashboard QR Code"
            setOnClickListener {
                val options = ScanOptions().apply {
                    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    setPrompt("Scan TakaLedger Merchant Device QR Code")
                    setBeepEnabled(false)
                    setOrientationLocked(true)
                }
                qrLauncher.launch(options)
            }
        }

        val pairBtn = Button(this).apply {
            text = "Pair Android Device"
            setOnClickListener {
                val baseUrl = urlInput.text.toString().trim().trimEnd('/')
                val code = codeInput.text.toString().trim().uppercase()
                if (baseUrl.isNotEmpty() && code.isNotEmpty()) {
                    performPairing(baseUrl, code)
                }
            }
        }

        val syncNowBtn = Button(this).apply {
            text = "Sync Offline Queue & Heartbeat Now"
            setOnClickListener {
                val req = OneTimeWorkRequestBuilder<EventSyncWorker>().build()
                WorkManager.getInstance(applicationContext)
                    .enqueueUniqueWork("takaledger_manual_sync", ExistingWorkPolicy.REPLACE, req)
                refreshDiagnostics()
            }
        }

        val unpairBtn = Button(this).apply {
            text = "Unpair / Reset Device Credentials"
            setOnClickListener {
                store.clearPairing()
                urlInput.setText("")
                codeInput.setText("")
                refreshDiagnostics()
            }
        }

        val rationaleView = TextView(this).apply {
            text = "Security & Multi-Merchant Isolation:\n" +
                "• Each Android phone binds to a single Merchant account via QR or one-time Pairing Code.\n" +
                "• Reads incoming payment notifications & optional Bank/Bangla QR SMS (bKash, Nagad, Rocket, Upay, CellFin, Bank SMS).\n" +
                "• OTP, PIN & password alerts are stripped locally before entering Room offline storage.\n" +
                "• Signed with HMAC-SHA256 + Android Keystore AES-256-GCM."
            setPadding(0, 16, 0, 24)
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
            addView(scanQrBtn)
            addView(urlInput)
            addView(codeInput)
            addView(pairBtn)
            addView(syncNowBtn)
            addView(unpairBtn)
            addView(rationaleView)
            addView(notifPermBtn)
            addView(smsPermBtn)
            addView(batteryBtn)
        }

        setContentView(ScrollView(this).apply { addView(layout) })
        schedulePeriodicSync()
        refreshDiagnostics()
    }

    override fun onResume() {
        super.onResume()
        refreshDiagnostics()
    }

    private fun handleQrPayload(raw: String) {
        try {
            val json = JSONObject(raw)
            val gatewayUrl = json.optString("gatewayUrl").trim().trimEnd('/')
            val pairingCode = json.optString("pairingCode").trim().uppercase()
            if (gatewayUrl.isNotEmpty() && pairingCode.isNotEmpty()) {
                urlInput.setText(gatewayUrl)
                codeInput.setText(pairingCode)
                performPairing(gatewayUrl, pairingCode)
                return
            }
        } catch (_: Exception) {
            // Fall back to URI parsing
        }
        statusView.text = "Scanned unrecognized QR content. Enter Gateway URL & Pairing Code manually."
    }

    @SuppressLint("MissingPermission")
    private fun collectSimSlots(): JSONArray {
        val array = JSONArray()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return array
        }
        runCatching {
            val sm = getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
            sm.activeSubscriptionInfoList?.forEach { info ->
                array.put(
                    JSONObject().apply {
                        put("slot", info.simSlotIndex + 1)
                        put("carrier", info.carrierName?.toString() ?: "SIM ${info.simSlotIndex + 1}")
                    }
                )
            }
        }
        return array
    }

    private fun performPairing(gatewayUrl: String, pairingCode: String) {
        scope.launch {
            statusView.text = "Pairing device with $gatewayUrl..."
            val resultText = withContext(Dispatchers.IO) {
                val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                val simSlots = collectSimSlots()
                val payload = JSONObject().apply {
                    put("pairingCode", pairingCode)
                    put("deviceUid", "AND-${androidId.take(10).uppercase()}")
                    put("androidModel", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("androidVersion", "Android ${Build.VERSION.RELEASE}")
                    put("appVersion", BuildConfig.VERSION_NAME)
                    put("simSlots", simSlots)
                }.toString()

                val req = Request.Builder()
                    .url("$gatewayUrl/api/v1/devices/pair")
                    .post(payload.toRequestBody("application/json".toMediaType()))
                    .build()

                try {
                    client.newCall(req).execute().use { res ->
                        val body = res.body?.string().orEmpty()
                        if (!res.isSuccessful) {
                            "Pairing failed (${res.code}): $body"
                        } else {
                            val json = JSONObject(body)
                            val providersJson = json.optJSONArray("assignedProviders")
                            val providers = mutableListOf<String>()
                            if (providersJson != null) {
                                for (i in 0 until providersJson.length()) {
                                    providers.add(providersJson.getString(i))
                                }
                            }
                            store.savePairing(
                                gatewayUrl = gatewayUrl,
                                deviceId = json.getString("deviceId"),
                                deviceToken = json.getString("deviceToken"),
                                hmacSecret = json.getString("hmacSecret"),
                                merchantId = json.optString("merchantId").takeIf { it.isNotBlank() },
                                deviceName = json.optString("deviceName").takeIf { it.isNotBlank() },
                                assignedProviders = providers
                            )
                            "Paired successfully as ${json.optString("deviceName", json.getString("deviceId"))}"
                        }
                    }
                } catch (e: Exception) {
                    "Network error: ${e.message}"
                }
            }
            statusView.text = resultText
            refreshDiagnostics()
        }
    }

    private fun refreshDiagnostics() {
        scope.launch {
            val (pendingCount, syncedCount) = withContext(Dispatchers.IO) {
                val dao = OfflineQueueDatabase.getInstance(applicationContext).dao()
                dao.getPendingCount() to dao.getSyncedCount()
            }
            val listenerEnabled = isListenerEnabled()
            val smsGranted = ContextCompat.checkSelfPermission(
                this@PairingActivity,
                Manifest.permission.RECEIVE_SMS
            ) == PackageManager.PERMISSION_GRANTED
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val batteryExempt = pm.isIgnoringBatteryOptimizations(packageName)

            val header = if (store.isPaired()) {
                val notice = store.getDeviceStatusNotice()
                val providers = store.getAssignedProviders().joinToString(", ").ifBlank { "ALL" }
                "Status: PAIRED (${store.getDeviceName() ?: store.getDeviceId()})\n" +
                    "Merchant Scope: ${store.getMerchantId() ?: "GLOBAL"}\n" +
                    "Gateway: ${store.getGatewayUrl()}\n" +
                    "Assigned Channels: $providers" +
                    if (!notice.isNullOrBlank()) "\nALERT: $notice" else ""
            } else {
                "Status: NOT PAIRED — Scan QR Code or enter Pairing Code from Merchant Dashboard"
            }

            statusView.text = "$header\n" +
                "App v${BuildConfig.VERSION_NAME} | Listener Active: $listenerEnabled | SMS Granted: $smsGranted\n" +
                "Battery Unrestricted: $batteryExempt | Queued: $pendingCount | Synced: $syncedCount" +
                if (store.isPaired()) "\nCrypto: Android Keystore AES-256-GCM + HMAC-SHA256" else ""
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
