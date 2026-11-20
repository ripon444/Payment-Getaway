import { getDb, isoNow } from '../db/client.ts';
import { emitWebhookDelivered } from '../realtime/socket.ts';
import { buildWebhookSignatureHeader, decryptSecret, newId } from '../utils/crypto.ts';
import { recordAuditLog } from './auditService.ts';

export type WebhookEventType =
  | 'payment.matched'
  | 'payment.review_required'
  | 'payment.verified_settled'
  | 'payment.failed';

interface MerchantWebhookConfig {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_secret_enc: string | null;
}

export async function dispatchMerchantWebhook(params: {
  merchantId: string;
  paymentIntentId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}): Promise<{ deliveryId: string | null; status: string }> {
  const db = getDb();
  const merchant = await db.queryOne<MerchantWebhookConfig>(
    'SELECT id, name, webhook_url, webhook_secret_enc FROM merchants WHERE id = ?',
    [params.merchantId],
  );

  const site = await db.queryOne<{ callback_url: string | null }>(
    `SELECT mw.callback_url
     FROM payment_intents p
     JOIN merchant_websites mw ON mw.id = p.website_id
     WHERE p.id = ? AND mw.is_active = 1`,
    [params.paymentIntentId],
  );

  const targetUrl = site?.callback_url?.trim() || merchant?.webhook_url?.trim() || null;

  if (!merchant || !targetUrl) {
    return { deliveryId: null, status: 'SKIPPED_NO_WEBHOOK_URL' };
  }

  let secret = '';
  if (merchant.webhook_secret_enc) {
    try {
      secret = decryptSecret(merchant.webhook_secret_enc);
    } catch {
      secret = '';
    }
  }

  const envelope = {
    id: newId(),
    event: params.eventType,
    createdAt: new Date().toISOString(),
    data: params.payload,
  };

  const rawBody = JSON.stringify(envelope);
  const signatureHeader = secret
    ? buildWebhookSignatureHeader(secret, rawBody)
    : 't=0,v1=unconfigured';

  const deliveryId = newId();
  const now = isoNow();

  await db.execute(
    `INSERT INTO webhook_deliveries (
      id, merchant_id, payment_intent_id, event_type, target_url, payload_json,
      signature_header, attempt_count, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', ?)`,
    [
      deliveryId,
      params.merchantId,
      params.paymentIntentId,
      params.eventType,
      targetUrl,
      rawBody,
      signatureHeader,
      now,
    ],
  );

  await attemptWebhookDelivery(deliveryId);
  const updated = await db.queryOne<{ status: string }>(
    'SELECT status FROM webhook_deliveries WHERE id = ?',
    [deliveryId],
  );
  return { deliveryId, status: updated?.status ?? 'PENDING' };
}

export async function attemptWebhookDelivery(deliveryId: string): Promise<{
  delivered: boolean;
  httpStatus: number | null;
  error?: string;
}> {
  const db = getDb();
  const row = await db.queryOne<{
    id: string;
    merchant_id: string;
    payment_intent_id: string;
    event_type: string;
    target_url: string;
    payload_json: string;
    signature_header: string;
    attempt_count: number;
  }>('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);

  if (!row) {
    return { delivered: false, httpStatus: null, error: 'Webhook delivery record not found' };
  }

  const nextAttempt = Number(row.attempt_count) + 1;
  let httpStatus: number | null = null;
  let responseBody = '';
  let delivered = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(row.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Event': row.event_type,
        'X-Gateway-Delivery': row.id,
        'X-Gateway-Signature': row.signature_header,
      },
      body: row.payload_json,
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = resp.status;
    responseBody = (await resp.text()).slice(0, 1000);
    delivered = resp.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message : 'Network error';
  }

  const status = delivered
    ? 'DELIVERED'
    : nextAttempt >= 5
      ? 'DEAD_LETTER'
      : 'FAILED';

  const retryDelayMs = Math.min(30_000 * Math.pow(2, nextAttempt), 3600_000);
  const nextRetryAt = delivered || status === 'DEAD_LETTER' ? null : isoNow(retryDelayMs);

  await db.execute(
    `UPDATE webhook_deliveries
     SET attempt_count = ?, http_status = ?, response_body = ?, status = ?, next_retry_at = ?, last_attempt_at = ?
     WHERE id = ?`,
    [nextAttempt, httpStatus, responseBody, status, nextRetryAt, isoNow(), deliveryId],
  );

  emitWebhookDelivered({
    deliveryId,
    merchantId: row.merchant_id,
    paymentIntentId: row.payment_intent_id,
    status,
    httpStatus,
  });

  await recordAuditLog({
    actorType: 'SYSTEM',
    actorId: 'webhook-dispatcher',
    action: delivered ? 'WEBHOOK_DELIVERED' : 'WEBHOOK_ATTEMPT_FAILED',
    resourceType: 'webhook_delivery',
    resourceId: deliveryId,
    afterState: { eventType: row.event_type, httpStatus, attemptCount: nextAttempt, status },
  });

  return { delivered, httpStatus, error: delivered ? undefined : responseBody };
}

export async function sendMerchantTestWebhook(params: {
  merchantId: string;
  websiteId?: string | null;
  targetUrlOverride?: string | null;
  actorId: string;
  actorEmail?: string | null;
}): Promise<{
  delivered: boolean;
  targetUrl: string | null;
  httpStatus: number | null;
  signatureHeader: string;
  responseBody: string;
  payload: Record<string, unknown>;
}> {
  const db = getDb();
  const merchant = await db.queryOne<MerchantWebhookConfig>(
    'SELECT id, name, webhook_url, webhook_secret_enc FROM merchants WHERE id = ?',
    [params.merchantId],
  );
  if (!merchant) {
    throw new Error('Merchant not found');
  }

  let siteUrl: string | null = null;
  if (params.websiteId) {
    const site = await db.queryOne<{ callback_url: string | null }>(
      'SELECT callback_url FROM merchant_websites WHERE id = ? AND merchant_id = ?',
      [params.websiteId, params.merchantId],
    );
    siteUrl = site?.callback_url ?? null;
  }

  const targetUrl =
    params.targetUrlOverride?.trim() || siteUrl?.trim() || merchant.webhook_url?.trim() || null;

  if (!targetUrl) {
    return {
      delivered: false,
      targetUrl: null,
      httpStatus: null,
      signatureHeader: '',
      responseBody: 'No webhook_url or website callback_url configured for this merchant.',
      payload: {},
    };
  }

  let secret = '';
  if (merchant.webhook_secret_enc) {
    try {
      secret = decryptSecret(merchant.webhook_secret_enc);
    } catch {
      secret = '';
    }
  }

  const payload = {
    id: newId(),
    event: 'webhook.test',
    createdAt: new Date().toISOString(),
    data: {
      merchantId: merchant.id,
      merchantName: merchant.name,
      mode: 'TEST',
      message: 'TakaLedger signed webhook connectivity verification.',
      samplePayment: {
        paymentId: `test_${newId().slice(0, 8)}`,
        merchantOrderId: `TL-TEST-${Date.now().toString().slice(-6)}`,
        provider: 'BKASH',
        amountBdt: 100.0,
        status: 'SUCCESS',
      },
    },
  };

  const rawBody = JSON.stringify(payload);
  const signatureHeader = secret
    ? buildWebhookSignatureHeader(secret, rawBody)
    : 't=0,v1=unconfigured';

  let httpStatus: number | null = null;
  let responseBody = '';
  let delivered = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Event': 'webhook.test',
        'X-Gateway-Delivery': payload.id,
        'X-Gateway-Signature': signatureHeader,
      },
      body: rawBody,
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = resp.status;
    responseBody = (await resp.text()).slice(0, 1000);
    delivered = resp.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message : 'Network error';
  }

  await recordAuditLog({
    actorType: 'USER',
    actorId: params.actorId,
    actorEmail: params.actorEmail ?? null,
    action: delivered ? 'WEBHOOK_TEST_DELIVERED' : 'WEBHOOK_TEST_FAILED',
    resourceType: 'merchant',
    resourceId: merchant.id,
    afterState: { targetUrl, httpStatus, delivered },
  });

  return { delivered, targetUrl, httpStatus, signatureHeader, responseBody, payload };
}

let retryWorkerTimer: ReturnType<typeof setInterval> | null = null;
let retryWorkerRunning = false;

export function startWebhookRetryWorker(intervalMs = 30_000): void {
  if (retryWorkerTimer) return;
  retryWorkerTimer = setInterval(async () => {
    if (retryWorkerRunning) return;
    retryWorkerRunning = true;
    try {
      const db = getDb();
      const now = isoNow();
      const due = await db.query<{ id: string }>(
        `SELECT id FROM webhook_deliveries
         WHERE status = 'FAILED' AND attempt_count < 5 AND next_retry_at IS NOT NULL AND next_retry_at <= ?
         ORDER BY next_retry_at ASC
         LIMIT 15`,
        [now],
      );
      for (const row of due) {
        await attemptWebhookDelivery(row.id);
      }
    } catch (err) {
      console.error('[WebhookRetryWorker] Tick failed:', err);
    } finally {
      retryWorkerRunning = false;
    }
  }, intervalMs);
  if (typeof retryWorkerTimer.unref === 'function') {
    retryWorkerTimer.unref();
  }
}

