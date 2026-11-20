package bd.takaledger.agent.crypto

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Stores paired multi-tenant device credentials inside Android Keystore-backed EncryptedSharedPreferences.
 * Enforces strict merchant isolation and never persists plaintext credentials outside Keystore encryption.
 */
class DeviceCryptoStore(context: Context) {

    private val masterKey: MasterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "takaledger_device_vault",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun savePairing(
        gatewayUrl: String,
        deviceId: String,
        deviceToken: String,
        hmacSecret: String,
        merchantId: String? = null,
        deviceName: String? = null,
        assignedProviders: List<String> = emptyList()
    ) {
        prefs.edit()
            .putString(KEY_GATEWAY_URL, gatewayUrl.trimEnd('/'))
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_TOKEN, deviceToken)
            .putString(KEY_HMAC_SECRET, hmacSecret)
            .putString(KEY_MERCHANT_ID, merchantId)
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_ASSIGNED_PROVIDERS, assignedProviders.joinToString(","))
            .remove(KEY_STATUS_NOTICE)
            .apply()
    }

    fun isPaired(): Boolean =
        !getGatewayUrl().isNullOrBlank() &&
            !getDeviceToken().isNullOrBlank() &&
            !getHmacSecret().isNullOrBlank()

    fun getGatewayUrl(): String? = prefs.getString(KEY_GATEWAY_URL, null)
    fun getDeviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)
    fun getDeviceToken(): String? = prefs.getString(KEY_DEVICE_TOKEN, null)
    fun getHmacSecret(): String? = prefs.getString(KEY_HMAC_SECRET, null)
    fun getMerchantId(): String? = prefs.getString(KEY_MERCHANT_ID, null)
    fun getDeviceName(): String? = prefs.getString(KEY_DEVICE_NAME, null)
    fun getAssignedProviders(): List<String> =
        prefs.getString(KEY_ASSIGNED_PROVIDERS, null)
            ?.split(",")
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

    fun setDeviceStatusNotice(notice: String?) {
        if (notice.isNullOrBlank()) {
            prefs.edit().remove(KEY_STATUS_NOTICE).apply()
        } else {
            prefs.edit().putString(KEY_STATUS_NOTICE, notice).apply()
        }
    }

    fun getDeviceStatusNotice(): String? = prefs.getString(KEY_STATUS_NOTICE, null)

    fun clearPairing() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val KEY_GATEWAY_URL = "gateway_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_HMAC_SECRET = "hmac_secret"
        private const val KEY_MERCHANT_ID = "merchant_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_ASSIGNED_PROVIDERS = "assigned_providers"
        private const val KEY_STATUS_NOTICE = "status_notice"

        fun sha256Hex(input: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(input.toByteArray(StandardCharsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }

        fun signHmacSha256(secret: String, timestampSec: Long, rawBody: String): String {
            val mac = Mac.getInstance("HmacSHA256")
            val keySpec = SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256")
            mac.init(keySpec)
            val canonical = "$timestampSec.$rawBody"
            val bytes = mac.doFinal(canonical.toByteArray(StandardCharsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
