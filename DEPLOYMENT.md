# TakaLedger Multi-Merchant Payment Verification Gateway — Production Deployment, Android APK & QA Guide

## 1. Architecture Overview (Unchanged Core Design)

- **Backend & Real-Time Engine**: Node.js 22+, Express, TypeScript (`server.ts` + `server/`), Socket.IO (`/socket.io` with tenant-isolated rooms `admin:global`, `merchant:<id>`, `checkout:<id>`), and React 19 + Tailwind CSS v4 (`src/`).
- **Database**: Production MySQL 8.0+ (`database/schema.sql`, + `database/migrations/001_add_parsed_transaction_time.sql` + `database/migrations/002_saas_platform_upgrade.sql`) with built-in Node 22 SQLite adapter (`./data/gateway.db`) when `MYSQL_HOST` is unset.
- **Modular Payment Parsers (`server/parsers/`)**:
  - `bkashParser.ts` (bKash Personal & Merchant)
  - `nagadParser.ts` (Nagad Personal & Merchant)
  - `rocketParser.ts` (DBBL Rocket Personal & Merchant)
  - `upayParser.ts` (Upay Personal, Customer `bd.com.upay.customer` & Merchant)
  - `cellfinParser.ts` (Islami Bank CellFin)
  - `banglaQrParser.ts` (Bangla QR / NPSB interoperable QR credits + EMVCo payload generator `server/utils/banglaQr.ts`)
  - `bankSmsParser.ts` (Extensible DB-backed Bank SMS regex template engine)
- **Android Notification & SMS Agent (`android-agent/`)**: Kotlin project (`v2.1.0`) using ZXing QR camera pairing, read-only `NotificationListenerService` + dual-SIM `BroadcastReceiver` (`RECEIVE_SMS`), local OTP/PIN redaction, Room SQLite offline queue (`OfflineQueueDatabase`), `WorkManager` (`NetworkType.CONNECTED` + exponential backoff), and Android Keystore `EncryptedSharedPreferences`.
- **WooCommerce Plugin (`woocommerce-plugin/takaledger-gateway/`)**: WordPress/WooCommerce payment gateway plugin with `X-Gateway-Signature` HMAC verification.

> **Verification & Settlement Policy**: Zero-TrxID customer sessions advance to `MATCHED` upon incoming Android SMS/app notification correlation. Depending on the merchant's `auto_verify_policy`, high-confidence deterministic personal/merchant proof (or configured Official Provider API) settles `MATCHED -> SUCCESS` automatically and dispatches signed webhooks; ambiguous or mismatched events remain in `REVIEW_REQUIRED` for finance approval.

---

## 2. Production `.env` Configuration & Secret Generation

1. Copy `.env.example` to `.env` inside `/opt/takaledger`:
   ```bash
   cp .env.example .env
   chmod 600 .env
   ```
2. Generate cryptographically strong 32-byte (64-char hex) secrets:
   ```bash
   node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
   node -e "console.log('WEBHOOK_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
   node -e "console.log('DEVICE_HMAC_PEPPER=' + require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Required Production Values in `.env`:
   - `NODE_ENV="production"`
   - `PORT=3000`
   - `APP_URL="https://pay.yourdomain.com"`
   - `MYSQL_HOST="127.0.0.1"`, `MYSQL_PORT=3306`, `MYSQL_USER="takaledger"`, `MYSQL_PASSWORD="..."`, `MYSQL_DATABASE="takaledger_gateway"`
   - `BOOTSTRAP_ADMIN_EMAIL="admin@yourdomain.com"`, `BOOTSTRAP_ADMIN_PASSWORD="..."` (Strong 16+ char password on initial boot; dev quick-login is automatically disabled when `NODE_ENV=production`)
   - Optional Official Provider API Credentials: `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `NAGAD_MERCHANT_ID`, `NAGAD_MERCHANT_PRIVATE_KEY`, `ROCKET_API_BASE_URL`, `ROCKET_MERCHANT_ID`, `ROCKET_API_SECRET`.

---

## 3. Production MySQL 8 Setup, Migration & Automated Backups

1. Create database and least-privilege user:
   ```sql
   CREATE DATABASE takaledger_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'takaledger'@'127.0.0.1' IDENTIFIED BY 'STRONG_RANDOM_DB_PASSWORD';
   GRANT SELECT, INSERT, UPDATE, DELETE ON takaledger_gateway.* TO 'takaledger'@'127.0.0.1';
   FLUSH PRIVILEGES;
   ```
2. Import fresh schema OR migrate an existing database:
   ```bash
   # Fresh installation:
   mysql -u root -p takaledger_gateway < database/schema.sql

   # Upgrading an existing MySQL 8 database:
   mysql -u root -p takaledger_gateway < database/migrations/001_add_parsed_transaction_time.sql
   mysql -u root -p takaledger_gateway < database/migrations/002_saas_platform_upgrade.sql
   ```
3. Enable daily automated backups with integrity verification & 14-day retention:
   ```bash
   chmod +x deploy/backup-mysql.sh
   sudo mkdir -p /var/backups/takaledger-mysql
   # Test manual backup run:
   sudo ENV_FILE=/opt/takaledger/.env /opt/takaledger/deploy/backup-mysql.sh
   # Schedule daily 02:00 UTC cron:
   echo "0 2 * * * root ENV_FILE=/opt/takaledger/.env /opt/takaledger/deploy/backup-mysql.sh >> /var/log/takaledger-backup.log 2>&1" | sudo tee /etc/cron.d/takaledger-mysql-backup
   ```

---

## 4. Production Server, NGINX + HTTPS (Let's Encrypt) + Systemd

1. Install dependencies, run tests, and build frontend:
   ```bash
   cd /opt/takaledger
   npm ci
   npm test
   npm run lint
   npm run build
   ```
2. Install systemd service (`/deploy/takaledger.service`):
   ```bash
   sudo cp deploy/takaledger.service /etc/systemd/system/takaledger.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now takaledger
   sudo systemctl status takaledger
   ```
3. Configure NGINX (`/deploy/nginx-takaledger.conf`) & issue Let's Encrypt TLS certificate:
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   sudo sed 's/pay.yourdomain.com/pay.YOURDOMAIN.COM/g' deploy/nginx-takaledger.conf | sudo tee /etc/nginx/sites-available/takaledger.conf
   sudo ln -sf /etc/nginx/sites-available/takaledger.conf /etc/nginx/sites-enabled/takaledger.conf
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d pay.YOURDOMAIN.COM
   ```
4. Verify HTTPS & WebSocket health:
   ```bash
   curl -fsS https://pay.YOURDOMAIN.COM/api/health
   ```

---

## 5. Android APK Build Instructions (`android-agent/`) — Debug & Release

### Gradle Configuration Summary
- `android-agent/settings.gradle.kts` (`TakaLedgerAgent`, `:app`)
- `android-agent/build.gradle.kts` (AGP `8.5.2`, Kotlin `1.9.24`, KSP `1.9.24-1.0.20`)
- `android-agent/gradle.properties` (`android.useAndroidX=true`, `kotlin.code.style=official`)
- `android-agent/app/build.gradle.kts` (`compileSdk = 34`, `minSdk = 26`, `targetSdk = 34`, `versionCode = 200`, `versionName = "2.0.0"`, JDK 17)
- `android-agent/app/proguard-rules.pro` (R8 rules for Room, WorkManager, OkHttp, Security Crypto, Services)

### Option A: Android Studio Hedgehog / Jellyfish+ (Recommended)
1. Open the `/android-agent` folder in **Android Studio** (SDK 34, JDK 17).
2. Let Gradle sync download dependencies (`androidx.room`, `androidx.work`, `androidx.security:security-crypto`, `okhttp`).
3. **Debug APK**:
   - Menu: **Build -> Build Bundle(s) / APK(s) -> Build APK(s)**
   - Output: `android-agent/app/build/outputs/apk/debug/app-debug.apk`
4. **Signed Release APK**:
   - Copy `android-agent/keystore.properties.example` to `android-agent/keystore.properties` (or generate keystore via `keytool`):
     ```bash
     keytool -genkey -v -keystore takaledger-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias takaledger-agent
     ```
   - Menu: **Build -> Generate Signed Bundle / APK -> APK -> release**, OR run via CLI once wrapper is initialized:
     ```bash
     cd android-agent
     gradle wrapper --gradle-version 8.7
     ./gradlew assembleDebug
     ./gradlew assembleRelease
     ```
   - Output: `android-agent/app/build/outputs/apk/release/app-release.apk`

---

## 6. Real Phone Device Pairing, Permissions, Battery & Offline Sync Guide

1. **Install APK**: Transfer `app-release.apk` (or `app-debug.apk`) to a dedicated Android 8.0+ device and install. (Note: Android 13/14 side-loaded apps may require tapping *App Info -> 3 dots -> Allow restricted settings* before enabling Notification Listener).
2. **Generate Pairing Code**: Log in to Admin/Merchant Portal -> **Android Devices -> Pair Android Device**, assign merchant + MFS/Bank wallets + providers, copy the `ABCD-EFGH` code.
3. **Pair App**:
   - Enter HTTPS URL (`https://pay.yourdomain.com` — HTTP cleartext is blocked by `usesCleartextTraffic="false"`) and Pairing Code.
   - Tap **Pair Android Device**. Credentials (`deviceToken`, `hmacSecret`) are stored inside Android Keystore `EncryptedSharedPreferences`.
4. **Permissions Verification**:
   - Tap **1. Grant Notification Listener Access** -> Toggle ON **TakaLedger MFS & Bank Notification Listener**.
   - Tap **2. Grant SMS Read Access** -> Allow `RECEIVE_SMS` & `READ_PHONE_STATE` (required for bank SMS & dual-SIM slot detection).
   - Tap **3. Disable Battery Optimization** -> Allow Unrestricted background battery. On Xiaomi/MIUI, Realme/ColorOS, or Vivo phones, also enable **Autostart** and lock the app in Recents.
5. **Verify Diagnostics**: Relaunch the app and confirm status shows:
   - `Listener Active: true | SMS Granted: true | Battery Unrestricted: true`
   - Check Dashboard **Android Devices** tab for live `ACTIVE` status and heartbeat telemetry.

---

## 7. Live WordPress / WooCommerce Integration Test Guide (`woocommerce-plugin/`)

1. Upload `takaledger-gateway-woocommerce.zip` via **WordPress Admin -> Plugins -> Add New -> Upload Plugin -> Activate**.
2. Go to **WooCommerce -> Settings -> Payments -> TakaLedger MFS & Bangla QR**:
   - Enable gateway
   - **Gateway Base URL**: `https://pay.yourdomain.com` (no trailing slash)
   - **Merchant API Key**: `tl_live_...`
   - **Webhook HMAC Secret**: Paste merchant webhook secret from TakaLedger
3. In TakaLedger **Merchants & Websites**, verify Website Callback URL or Merchant Webhook URL is set to:
   `https://yourstore.bd/wp-json/takaledger/v1/webhook`
   *(Confirm WordPress Permalinks are NOT set to "Plain", so `/wp-json/` REST routes resolve!)*
4. **End-to-End WooCommerce Order Flow**:
   - Place a test checkout order (e.g., `WC-1001`) -> verify TakaLedger creates `PENDING` session and WooCommerce sets order to **On hold**.
   - Trigger incoming MFS/Bangla QR payment -> verify `payment.matched` webhook adds an order note *"Notification candidate matched. Waiting for authoritative verification"* while WooCommerce order **remains On hold**.
   - Perform Documented Manual Verification (or configured Provider API) in TakaLedger -> verify `payment.verified_settled` (`status: SUCCESS`) updates WooCommerce order to **Processing / Completed** with Transaction ID recorded.
