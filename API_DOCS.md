# TakaLedger Commercial Multi-Merchant SaaS Gateway — REST API, Zero-TrxID & Webhook Reference

## 1. Merchant Public API (`/api/v1/*`)

Authenticate all Merchant API calls with either:
- `Authorization: Bearer tl_live_<key>` (or `tl_test_<key>` for Sandbox Test Mode)
- `X-Merchant-Key: tl_live_<key>` (or `tl_test_<key>`)
- Optional `X-Api-Secret: tl_sec_<secret>` (verified if supplied)

### `GET /api/v1/methods`
Returns payment methods allowed by the merchant's active subscription plan along with active receiving wallets.

### `POST /api/v1/payments`
Create a Zero-TrxID hosted checkout session (idempotent via `Idempotency-Key` header).

**Request Body**:
```json
{
  "merchantOrderId": "ORD-99102",
  "provider": "BKASH",
  "accountMode": "PERSONAL",
  "amountBdt": 1850.00,
  "uniqueMicroAmount": true,
  "customerName": "Rahim Uddin",
  "customerPhone": "01711223344",
  "customerEmail": "rahim@example.bd",
  "successUrl": "https://yourstore.bd/payment/success",
  "cancelUrl": "https://yourstore.bd/payment/cancel",
  "callbackUrl": "https://yourstore.bd/api/takaledger-webhook"
}
```
Supported `provider` values: `BKASH`, `NAGAD`, `ROCKET`, `UPAY`, `CELLFIN`, `BANGLA_QR`, `BANK_SMS`.
Supported `accountMode` values: `PERSONAL`, `MERCHANT`, `AGENT`, `BANK_ACCOUNT`.

**Response (`201 Created`)**:
```json
{
  "paymentId": "uuid",
  "merchantOrderId": "ORD-99102",
  "mode": "LIVE",
  "provider": "BKASH",
  "accountMode": "PERSONAL",
  "amountBdt": 1850.23,
  "requestedAmountBdt": 1850,
  "uniquePaisaOffset": 23,
  "currency": "BDT",
  "referenceCode": "TL8A4K2P",
  "banglaQrString": "000201010212...",
  "checkoutUrl": "https://pay.yourdomain.com/?checkout=uuid",
  "successUrl": "https://yourstore.bd/payment/success",
  "cancelUrl": "https://yourstore.bd/payment/cancel",
  "status": "PENDING",
  "expiresAt": "2026-11-20T12:00:00Z"
}
```

### `GET /api/v1/payments/:id`
Retrieve live payment lifecycle status (`PENDING` | `DETECTED` | `MATCHED` | `REVIEW_REQUIRED` | `VERIFIED` | `SUCCESS` | `FAILED` | `EXPIRED`), verification method, match confidence, and settlement details.

### `POST /api/v1/webhooks/test`
Dispatches a signed `webhook.test` event to the merchant's configured webhook URL for integration diagnostics.

### `GET /api/v1/merchant/websites` & `POST /api/v1/merchant/websites`
List or register merchant storefronts (subject to active SaaS plan website quota).

---

## 2. Hosted Zero-TrxID Customer Checkout API (`/api/checkout/*`)

- `GET /api/checkout/:id` — Returns merchant name, mode (`LIVE`/`TEST`), exact amount (including any `uniquePaisaOffset`), available wallets, `qrDataUrl`, `banglaQrString`, and redirect URLs.
- `POST /api/checkout/:id/confirm-sent` — Zero-TrxID customer confirmation (`{ provider, senderPhone?, testSimulateSuccess? }`). **No TrxID or screenshot upload required.** Transitions `PENDING -> DETECTED`, checks pre-arrived device notifications, and auto-settles (`SUCCESS`) in Test Sandbox mode if `testSimulateSuccess: true` when `mode === 'TEST'`.
- `POST /api/checkout/:id/cancel` — Cancels an open checkout session (`FAILED`) and returns `cancelUrl`.
- `POST /api/checkout/:id/submit` — Legacy compatibility endpoint if older clients submit `{ provider, senderPhone, trxId }`.

---

## 3. SaaS Packages, Subscriptions & Merchant Self-Service (`/api/*`)

- `GET /api/packages` — Public SaaS pricing tiers (`Starter`, `Basic`, `Professional`, `Business`, `Enterprise`).
- `POST /api/auth/register-merchant` — Public merchant onboarding (creates merchant tenant, `MERCHANT_ADMIN` owner, optional website, 14-day `TRIAL` subscription, and one-time Live/Test/API Secret/Webhook Secret credentials).
- `GET /api/merchant/subscription` & `POST /api/merchant/subscription` — Quota meters, invoice history, and plan upgrade/renewal.
- `GET /api/merchant/reports/export?format=csv|json` — Export transaction history (accessible even if subscription is expired).
- `GET /api/merchant/apk-info` — Returns Android Agent APK `2.1.0` capabilities and pairing endpoints.
- `POST /api/merchants/websites/:siteId/verify` — Verifies domain ownership (`DNS_TXT`, `HTML_META`, `HTTP_FILE`, `SANDBOX_CONFIRM`).
- `GET/POST/PATCH /api/admin/packages`, `GET /api/admin/subscriptions`, `PATCH /api/admin/merchants/:id/status` — Super Admin SaaS controls.

---

## 4. Android Agent Telemetry & Ingestion API

Device requests must include:
- `Authorization: Bearer tldev_<deviceToken>`
- `X-Device-Timestamp: <unix_seconds>` (anti-replay window: ±5 minutes)
- `X-Device-Signature: hmac_sha256("${timestamp}.${rawBody}", hmacSecret)`

Endpoints:
- `POST /api/v1/devices/pair` (or `/api/devices/pair`) — Consumes 15-minute one-time QR `pairingCode` and issues `deviceToken` + `hmacSecret`.
- `POST /api/devices/heartbeat` — Reports `batteryPct`, `networkType`, `appVersion`, `queueDepth`, and dual-SIM `simSlots`.
- `POST /api/v1/notifications/ingest` (or `/api/notifications/ingest`) — Single push notification or SMS ingestion (`sourceChannel`: `NOTIFICATION` | `SMS`, `senderHeader`, `packageName`, `title`, `body`, `simSlot`, `eventUid`).
- `POST /api/notifications/ingest-batch` — Batch flush from Android Room offline queue (`events[]`, max 100 per batch).

---

## 5. Signed Webhooks (`X-Gateway-Signature`)

TakaLedger dispatches webhooks (with background retry worker on failures) on:
- `payment.matched`
- `payment.verified_settled` (`status: "SUCCESS"`)
- `payment.failed` (`status: "FAILED"`)
- `webhook.test`

**Headers**:
- `X-Gateway-Event`: event type
- `X-Gateway-Signature`: `t=<unix_seconds>,v1=<hex_hmac_sha256>`

---

## 6. Real-Time Socket.IO Events (`/socket.io`)

- Authenticated dashboard rooms (`admin:global` or `merchant:<merchantId>`): `payment:updated`, `notification:ingested`, `device:telemetry`, `fraud:alert`, `webhook:delivered`.
- Checkout room (`checkout:<paymentId>`): `checkout:status`.
