# TakaLedger Multi-Merchant Gateway — REST API, Real-Time & Webhook Reference

## 1. Merchant Public API (`/api/v1/*`)

Authenticate all Merchant API calls with:
- `X-Merchant-Key: tl_live_<key>` (or `Authorization: Bearer tl_live_<key>`)

### `GET /api/v1/methods`
Returns all currently enabled payment methods and merchant receiving accounts.

### `POST /api/v1/payments`
Create a hosted checkout session (idempotent via `Idempotency-Key` header).

**Headers**:
- `X-Merchant-Key: tl_live_...`
- `Idempotency-Key: unique-order-idempotency-key`

**Request Body**:
```json
{
  "merchantOrderId": "ORD-99102",
  "provider": "BANGLA_QR",
  "accountMode": "MERCHANT",
  "amountBdt": 1850.00,
  "customerName": "Rahim Uddin",
  "customerPhone": "01711223344",
  "customerEmail": "rahim@example.bd"
}
```
Supported `provider` values: `BKASH`, `NAGAD`, `ROCKET`, `UPAY`, `CELLFIN`, `BANGLA_QR`, `BANK_SMS`.

**Response (`201 Created`)**:
```json
{
  "paymentId": "uuid",
  "merchantOrderId": "ORD-99102",
  "provider": "BANGLA_QR",
  "amountBdt": 1850,
  "currency": "BDT",
  "referenceCode": "TL8A4K2P",
  "banglaQrString": "000201010212...",
  "checkoutUrl": "https://pay.yourdomain.com/?checkout=uuid",
  "status": "PENDING",
  "expiresAt": "2026-11-18T12:00:00Z"
}
```

### `GET /api/v1/payments/:id`
Retrieve live payment lifecycle status (`PENDING` | `DETECTED` | `MATCHED` | `REVIEW_REQUIRED` | `VERIFIED` | `SUCCESS` | `FAILED` | `EXPIRED`), match confidence, and settlement details.

---

## 2. Hosted Customer Checkout API (`/api/checkout/*`)

- `GET /api/checkout/:id` — Returns merchant name, amount in BDT, available wallets, `qrDataUrl`, and EMVCo `banglaQrString` + `banglaQrDataUrl`.
- `POST /api/checkout/:id/submit` — Customer submits `{ provider, senderPhone, trxId }`. Blocks already-verified TrxIDs (`409 Conflict`).

---

## 3. Android Agent Telemetry & Ingestion API

Device requests must include:
- `Authorization: Bearer tldev_<deviceToken>`
- `X-Device-Timestamp: <unix_ms>` (anti-replay window: ±5 minutes)
- `X-Device-Signature: hmac_sha256("${timestamp}.${rawBody}", hmacSecret)`

Endpoints:
- `POST /api/devices/pair` — Consumes 15-minute one-time `pairingCode` and issues `deviceToken` + `hmacSecret`.
- `POST /api/devices/heartbeat` — Reports `batteryPct`, `networkType`, `queueDepth`, and `simSlots`.
- `POST /api/notifications/ingest` — Single push notification or SMS ingestion (`sourceChannel`: `NOTIFICATION` | `SMS`, `senderHeader`, `packageName`, `title`, `body`, `simSlot`, `eventUid`).
- `POST /api/notifications/ingest-batch` — Batch flush from Android encrypted Room offline queue (`events[]`, max 100 per batch).

---

## 4. Signed Webhooks (`X-Gateway-Signature`)

TakaLedger dispatches webhooks to the merchant's `webhook_url` on:
- `payment.verified_settled` (`status: "SUCCESS"`)
- `payment.failed` (`status: "FAILED"`)

**Headers**:
- `X-Gateway-Event`: `payment.verified_settled`
- `X-Gateway-Signature`: `t=<unix_seconds>,v1=<hex_hmac_sha256>`

**Verification Example (Node.js)**:
```js
import crypto from 'node:crypto';

export function verifyWebhook(rawBody, signatureHeader, webhookSecret) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((kv) => kv.split('=')));
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));
}
```

---

## 5. Real-Time Socket.IO Events (`/socket.io`)

- Connect with `{ auth: { token } }` for Admin (`admin:global`) or Merchant (`merchant:<merchantId>`) live events:
  - `payment:updated`
  - `notification:ingested`
  - `device:telemetry`
  - `fraud:alert`
  - `webhook:delivered`
- Connect with `{ query: { checkoutId } }` on the checkout page to listen for `checkout:status`.
