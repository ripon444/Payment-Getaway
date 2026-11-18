package bd.takaledger.agent.worker

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import bd.takaledger.agent.crypto.DeviceCryptoStore
import bd.takaledger.agent.data.OfflineQueueDatabase
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class EventSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val store = DeviceCryptoStore(applicationContext)
        if (!store.isPaired()) return Result.success()

        val gatewayUrl = store.getGatewayUrl() ?: return Result.failure()
        val token = store.getDeviceToken() ?: return Result.failure()
        val hmacSecret = store.getHmacSecret() ?: return Result.failure()

        val dao = OfflineQueueDatabase.getInstance(applicationContext).dao()
        val batch = dao.getPendingBatch(50)

        if (batch.isNotEmpty()) {
            val eventsArray = JSONArray()
            for (item in batch) {
                eventsArray.put(
                    JSONObject().apply {
                        put("eventUid", item.eventUid)
                        put("packageName", item.packageName)
                        put("title", item.title ?: JSONObject.NULL)
                        put("body", item.bodyRedacted)
                        put("deviceTimestampMs", item.deviceTimestampMs)
                    }
                )
            }

            val rawBody = JSONObject().put("events", eventsArray).toString()
            val timestampSec = System.currentTimeMillis() / 1000L
            val signature = DeviceCryptoStore.signHmacSha256(hmacSecret, timestampSec, rawBody)

            val request = Request.Builder()
                .url("$gatewayUrl/api/notifications/ingest-batch")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("X-Device-Timestamp", timestampSec.toString())
                .addHeader("X-Device-Signature", signature)
                .post(rawBody.toRequestBody("application/json; charset=utf-8".toMediaType()))
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    val uids = batch.map { it.eventUid }
                    if (response.isSuccessful) {
                        dao.markSynced(uids)
                        dao.pruneSyncedOlderThan(System.currentTimeMillis() - 7L * 24 * 3600 * 1000)
                    } else if (response.code in 401..403) {
                        dao.recordFailure(uids, "Auth/Revoked HTTP ${response.code}")
                        return Result.failure()
                    } else {
                        dao.recordFailure(uids, "HTTP ${response.code}")
                        return Result.retry()
                    }
                }
            } catch (ex: Exception) {
                dao.recordFailure(batch.map { it.eventUid }, ex.message ?: "Network error")
                return Result.retry()
            }
        }

        // Send device telemetry heartbeat
        sendHeartbeat(gatewayUrl, token, hmacSecret, dao.getPendingCount())
        return Result.success()
    }

    private fun sendHeartbeat(gatewayUrl: String, token: String, hmacSecret: String, queueDepth: Int) {
        val batteryIntent = applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val batteryPct = if (level >= 0 && scale > 0) (level * 100) / scale else 100

        val rawBody = JSONObject().apply {
            put("batteryPct", batteryPct)
            put("networkType", resolveNetworkType())
            put("queueDepth", queueDepth)
        }.toString()

        val ts = System.currentTimeMillis() / 1000L
        val sig = DeviceCryptoStore.signHmacSha256(hmacSecret, ts, rawBody)

        val req = Request.Builder()
            .url("$gatewayUrl/api/devices/heartbeat")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("X-Device-Timestamp", ts.toString())
            .addHeader("X-Device-Signature", sig)
            .post(rawBody.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()

        runCatching { client.newCall(req).execute().close() }
    }

    private fun resolveNetworkType(): String {
        val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "OFFLINE"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "4G LTE"
            else -> "OTHER"
        }
    }
}
