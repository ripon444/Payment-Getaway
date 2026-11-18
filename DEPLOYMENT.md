# TakaLedger Multi-Merchant Payment Gateway — Installation, Deployment & Provider Matrix

## 1. Architecture Overview

- **Backend & Real-Time Engine**: Node.js 22+, Express, TypeScript (`server.ts` + `server/`), Socket.IO (`/socket.io` with tenant-isolated rooms `admin:global`, `merchant:<id>`, `checkout:<id>`), and React 19 + Tailwind CSS v4 (`src/`).
- **Database**: Production MySQL 8.0+ (`database/schema.sql`, 16 tables) with built-in Node 22 SQLite adapter (`./data/gateway.db`) when `MYSQL_HOST` is unset.
- **Modular Payment Parsers (`server/parsers/`)**:
  - `bkashParser.ts` (bKash Personal & Merchant)
  - `nagadParser.ts` (Nagad Personal & Merchant)
  - `rocketParser.ts` (DBBL Rocket Personal & Merchant)
  - `upayParser.ts` (Upay Personal & Merchant)
  - `cellfinParser.ts` (Islami Bank CellFin)
  - `banglaQrParser.ts` (Bangla QR / NPSB interoperable QR credits + EMVCo payload generator `server/utils/banglaQr.ts`)
  - `bankSmsParser.ts` (Extensible DB-backed Bank SMS regex template engine)
- **Android Notification & SMS Agent (`android-agent/`)**: Kotlin project using read-only `NotificationListenerService` + optional `BroadcastReceiver` (`RECEIVE_SMS` for dual-SIM bank/MFS SMS), local OTP/PIN redaction, Room SQLite encrypted-at-rest offline queue, `WorkManager` exponential backoff sync, and Android Keystore `EncryptedSharedPreferences`.
- **WooCommerce Plugin (`woocommerce-plugin/takaledger-gateway/`)**: Ready-to-upload WordPress/WooCommerce payment gateway plugin with `X-Gateway-Signature` HMAC verification.

---

## 2. Supported Provider & Bangla QR Reliability Matrix

| Provider Code | Personal / Merchant | Detection Source | Bangla QR Cross-Match | Official API Settlement |
|---|---|---|---|---|
| `BKASH` | Personal / Merchant | App Notification + SMS | Yes (bKash Bangla QR) | Supported when bKash Tokenized Checkout API credentials are configured in `.env` |
| `NAGAD` | Personal / Merchant | App Notification + SMS | Yes (Nagad Bangla QR) | Supported when Nagad Merchant API credentials are configured in `.env` |
| `ROCKET` | Personal / Merchant | App Notification + `16216` SMS | Yes (NexusPay / Rocket QR) | Supported when DBBL Merchant API credentials are configured in `.env` |
| `UPAY` | Personal / Merchant | App Notification + SMS | Partial (UCB / Upay QR) | Documented Manual Finance Verification (portal/statement ref) |
| `CELLFIN` | Bank / Wallet | CellFin Push + `IBBL` SMS | Yes (Islami Bank Bangla QR) | Documented Manual Finance Verification (bank statement ref) |
| `BANGLA_QR` | Merchant QR | Bank SMS (`CITYBANK`, `DBBL`, `IBBL`, `BRAC`) + MFS Push | Primary EMVCo Dynamic QR | Documented Manual Finance Verification or Bank Portal Confirmation |
| `BANK_SMS` | Bank Account | Carrier SMS via `bank_sms_templates` | Yes (NPSB / BEFTN alerts) | Documented Manual Finance Verification (bank portal/statement ref) |

> **Critical Compliance Rule**: SMS and push notifications alone NEVER mark a payment `VERIFIED` or `SUCCESS`. They advance orders to `MATCHED` or `REVIEW_REQUIRED`. Final settlement (`SUCCESS`) requires official Provider API confirmation or Documented Manual Finance Verification (`SUPER_ADMIN` / `FINANCE_REVIEWER` + mandatory documentary evidence reference).

---

## 3. Production MySQL 8 Setup

1. Create database and least-privilege user:

```sql
CREATE DATABASE takaledger_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'takaledger'@'%' IDENTIFIED BY 'STRONG_RANDOM_DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON takaledger_gateway.* TO 'takaledger'@'%';
FLUSH PRIVILEGES;
```

2. Import schema:

```bash
mysql -u root -p takaledger_gateway < database/schema.sql
```

---

## 4. Environment Configuration (`.env`)

Copy `.env.example` to `.env` and generate strong secrets:

```bash
cp .env.example .env
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('WEBHOOK_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('DEVICE_HMAC_PEPPER=' + require('crypto').randomBytes(32).toString('hex'))"
```

Configure:
- `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`
- `APP_URL=https://pay.yourdomain.com`
- Optional official merchant API credentials: `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `NAGAD_MERCHANT_ID`, `NAGAD_MERCHANT_PRIVATE_KEY`, `ROCKET_MERCHANT_ID`, `ROCKET_API_SECRET`.

---

## 5. Build, Test & NGINX + Socket.IO Reverse Proxy

```bash
npm install
npm test
npm run build
NODE_ENV=production npm start
```

Configure NGINX with TLS 1.3 and **WebSocket upgrade headers** for `/socket.io`:

```nginx
server {
    listen 443 ssl http2;
    server_name pay.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/pay.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.yourdomain.com/privkey.pem;

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 6. Android Agent APK Build & Device Setup (`android-agent/`)

1. Open `/android-agent` in **Android Studio Hedgehog+** (JDK 17, Android SDK 34, Gradle KTS).
2. Build a signed APK:
   - GUI: **Build -> Generate Signed Bundle / APK -> APK -> release**
   - CLI (once Gradle wrapper is generated in Android Studio): `./gradlew assembleRelease`
3. Install the APK on dedicated merchant Android phones (Android 8.0+ / API 26+).
4. In the Admin or Merchant Portal (`Android Devices -> Pair Android Device`), generate a 15-minute Pairing Code & QR.
5. On **TakaLedger Agent**:
   - Enter the HTTPS Gateway URL and Pairing Code (or scan QR).
   - **Notification Permission**: Tap *Enable Notification Listener* so the app reads incoming MFS/CellFin/Bank notifications (read-only; no UI automation).
   - **SMS Permission (Optional)**: Grant `RECEIVE_SMS` if listening for bank SMS (`CITYBANK`, `DBBL`, `IBBL`, `16216`) or Bangla QR SMS on Dual-SIM slots.
   - **Battery Optimization**: Tap *Disable Battery Optimization* (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) so Doze mode does not interrupt background Room queue syncing.

---

## 7. WooCommerce Plugin Installation (`woocommerce-plugin/takaledger-gateway/`)

1. Zip `woocommerce-plugin/takaledger-gateway/` and upload it via **WordPress Admin -> Plugins -> Add New -> Upload Plugin**.
2. Activate **TakaLedger Bangladesh MFS & Bangla QR Gateway**.
3. Go to **WooCommerce -> Settings -> Payments -> TakaLedger**:
   - **Gateway Base URL**: `https://pay.yourdomain.com`
   - **Merchant API Key**: `tl_live_...` (from Merchants & Websites tab)
   - **Webhook HMAC Secret**: Paste your merchant Webhook Secret
   - Copy the displayed Webhook URL (`https://yourstore.bd/wp-json/takaledger/v1/webhook`) into your Merchant profile or Website callback URL in TakaLedger.
4. Only `payment.verified_settled` webhooks with `status === "SUCCESS"` and a valid `X-Gateway-Signature` HMAC complete WooCommerce orders.
