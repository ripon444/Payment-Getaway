# TakaLedger MFS Payment Gateway — Installation & Deployment Guide

## 1. Architecture Overview

- **Backend & Web Console**: Node.js 22+, Express, TypeScript (`server.ts` + `server/`), React 19 + Tailwind CSS v4 (`src/`).
- **Database**: Production MySQL 8.0+ (`database/schema.sql`) with built-in Node 22 SQLite fallback (`./data/gateway.db`) when `MYSQL_HOST` is unset.
- **Provider Parsers**: Separate parser modules for bKash (`bkashParser.ts`), Nagad (`nagadParser.ts`), and DBBL Rocket (`rocketParser.ts`) with local & server-side OTP/PIN redaction.
- **Android Notification Agent**: Kotlin project (`android-agent/`) using read-only `NotificationListenerService`, Room SQLite offline queue, `WorkManager` exponential backoff batch sync, and Android Keystore `EncryptedSharedPreferences`.

---

## 2. Production MySQL 8 Setup

1. Install MySQL 8.0+ and create a dedicated database and least-privilege user:

```sql
CREATE DATABASE takaledger_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'takaledger'@'%' IDENTIFIED BY 'STRONG_RANDOM_DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON takaledger_gateway.* TO 'takaledger'@'%';
FLUSH PRIVILEGES;
```

2. Import the schema:

```bash
mysql -u root -p takaledger_gateway < database/schema.sql
```

---

## 3. Environment Configuration (`.env`)

Copy `.env.example` to `.env` and populate strong random cryptographic keys:

```bash
cp .env.example .env
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('WEBHOOK_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('DEVICE_HMAC_PEPPER=' + require('crypto').randomBytes(32).toString('hex'))"
```

Set `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and `APP_URL` (`https://pay.yourdomain.com`).

> **Important**: Never commit `.env` or embed API keys/passwords in source code. Official bKash/Nagad/Rocket Merchant Verification API credentials should be injected via environment variables or a secret manager.

---

## 4. Build & Run Backend + Frontend

```bash
npm install
npm run build
NODE_ENV=production npm start
```

For process supervision with **systemd** (`/etc/systemd/system/takaledger.service`):

```ini
[Unit]
Description=TakaLedger MFS Payment Gateway
After=network.target mysql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/takaledger
EnvironmentFile=/opt/takaledger/.env
ExecStart=/usr/bin/node server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Place **NGINX** with TLS 1.3 (Let's Encrypt / Certbot) in front of `127.0.0.1:3000`:

```nginx
server {
    listen 443 ssl http2;
    server_name pay.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/pay.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.yourdomain.com/privkey.pem;

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

## 5. Android Notification Agent Setup (`android-agent/`)

1. Open `android-agent/` in Android Studio Hedgehog+ (JDK 17, Android SDK 34).
2. Build a signed release APK (`Build > Generate Signed Bundle / APK`).
3. Install on dedicated merchant SIM phones (Android 8.0+ / API 26+).
4. In the Admin Dashboard (`Android Devices -> Pair Android Device`), generate a 15-minute Pairing Code & QR.
5. Open **TakaLedger Agent** on the phone:
   - Enter Gateway HTTPS URL and the Pairing Code.
   - Tap **Enable Notification Listener Access** and grant permission to `TakaLedger MFS Notification Listener`.
   - Disable battery optimization for `TakaLedger Agent` so `WorkManager` syncs reliably in the background.

---

## 6. Merchant Integration & Webhook Verification

Merchants create checkout sessions via `POST /api/v1/payments` with `X-Merchant-Key` and `Idempotency-Key`.

All webhooks include:
- `X-Gateway-Event`: e.g. `payment.candidate_matched` or `payment.verified_settled`
- `X-Gateway-Signature`: `t=<unix_timestamp>,v1=<hmac_sha256_hex>`

**Only treat `payment.verified_settled` as settled payment.** Verify the HMAC signature over `${t}.${rawBody}` using constant-time comparison before fulfilling customer orders.
