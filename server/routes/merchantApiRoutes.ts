import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireDeviceAuth, requireMerchantApi } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { emitDeviceTelemetry, emitPaymentUpdated } from '../realtime/socket.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  assertPaymentCreationAllowed,
  assertWebsiteQuota,
  EntitlementError,
  getMerchantEntitlements,
} from '../services/entitlementService.ts';
import { ingestDeviceNotification } from '../services/matchingEngine.ts';
import { sendMerchantTestWebhook } from '../services/webhookService.ts';
import { buildBanglaQrString } from '../utils/banglaQr.ts';
import { encryptSecret, generateSecretHex, newId, sha256Hex } from '../utils/crypto.ts';

export const merchantApiRoutes = Router();

const VALID_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CELLFIN', 'BANGLA_QR', 'BANK_SMS'];

async function logApiUsage(merchantId: string, endpoint: string, method: string, statusCode: number, startedMs: number) {
  const db = getDb();
  await db.execute(
    `INSERT INTO api_usage_logs (id, merchant_id, endpoint, method, status_code, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId(), merchantId, endpoint, method, statusCode, Math.max(1, Date.now() - startedMs), isoNow()],
  );
}

async function allocateMicroAmount(
  merchantId: string,
  provider: string,
  requestedAmountBdt: number,
  forceMicroAmount: boolean,
): Promise<{ payableAmountBdt: number; paisaOffset: number }> {
  const db = getDb();
  const baseRounded = Math.round(requestedAmountBdt * 100) / 100;
  const activeRows = await db.query<{ amount_bdt: number }>(
    `SELECT amount_bdt FROM payment_intents
     WHERE merchant_id = ? AND provider = ? AND status IN ('PENDING', 'DETECTED')
       AND amount_bdt >= ? AND amount_bdt < ?`,
    [merchantId, provider, baseRounded, baseRounded + 1.0],
  );

  const usedAmounts = new Set(activeRows.map((r) => Number(r.amount_bdt).toFixed(2)));
  if (!forceMicroAmount && !usedAmounts.has(baseRounded.toFixed(2))) {
    return { payableAmountBdt: baseRounded, paisaOffset: 0 };
  }

  for (let i = 1; i <= 99; i++) {
    const offset = i / 100;
    const candidate = Number((baseRounded + offset).toFixed(2));
    if (!usedAmounts.has(candidate.toFixed(2))) {
      return { payableAmountBdt: candidate, paisaOffset: offset };
    }
  }
  return { payableAmountBdt: baseRounded, paisaOffset: 0 };
}

// Get Supported & Enabled Payment Methods for Authenticated Merchant
merchantApiRoutes.get('/methods', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  const db = getDb();
  const ent = await getMerchantEntitlements(req.merchant!.id);
  const allowedByPlan = ent.package?.allowedProviders ?? VALID_PROVIDERS;

  const methods = await db.query<{
    provider_code: string;
    display_name: string;
    supports_personal: number;
    supports_merchant: number;
    supports_api_verification: number;
    bangla_qr_reliable: number;
    reliability_notes: string;
    wallet_id: string | null;
    account_number: string | null;
    account_type: string | null;
    bank_name: string | null;
  }>(
    `SELECT p.provider_code, p.display_name, p.supports_personal, p.supports_merchant,
            p.supports_api_verification, p.bangla_qr_reliable, p.reliability_notes,
            w.id AS wallet_id, w.account_number, w.account_type, w.bank_name
     FROM providers_config p
     LEFT JOIN mfs_wallets w ON w.provider = p.provider_code AND w.merchant_id = ? AND w.is_active = 1
     WHERE p.is_enabled = 1
     ORDER BY p.provider_code`,
    [req.merchant!.id],
  );

  const filtered = methods.filter((m) => allowedByPlan.includes(m.provider_code));
  await logApiUsage(req.merchant!.id, '/api/v1/methods', 'GET', 200, started);
  res.json({ merchant: req.merchant!.name, mode: req.merchant!.mode, methods: filtered });
});

// Create Zero-TrxID Payment Session (Idempotent + Plan/Website/Mode aware)
merchantApiRoutes.post('/payments', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  const merchantId = req.merchant!.id;
  const merchantOrderId = String(req.body?.merchantOrderId ?? '').trim();
  const idempotencyKey = String(req.header('Idempotency-Key') || req.body?.idempotencyKey || merchantOrderId).trim();
  const provider = String(req.body?.provider ?? '').toUpperCase();
  const requestedAccountMode = req.body?.accountMode ? String(req.body.accountMode).toUpperCase() : null;
  const requestedAmountBdt = Number(req.body?.amountBdt ?? 0);
  const customerName = req.body?.customerName ? String(req.body.customerName).trim() : null;
  const customerPhone = req.body?.customerPhone ? String(req.body.customerPhone).trim() : null;
  const customerEmail = req.body?.customerEmail ? String(req.body.customerEmail).trim() : null;
  const uniqueMicroAmount = req.body?.uniqueMicroAmount === true;

  if (!merchantOrderId || !VALID_PROVIDERS.includes(provider) || !Number.isFinite(requestedAmountBdt) || requestedAmountBdt <= 0) {
    await logApiUsage(merchantId, '/api/v1/payments', 'POST', 400, started);
    res.status(400).json({
      error: `merchantOrderId, provider (${VALID_PROVIDERS.join('|')}), and positive amountBdt are required`,
    });
    return;
  }

  const db = getDb();

  // Check idempotent replay first
  const existing = await db.queryOne<{
    id: string;
    status: string;
    mode: string;
    provider: string;
    account_mode: string;
    amount_bdt: number;
    requested_amount_bdt: number | null;
    unique_paisa_offset: number;
    reference_code: string;
    success_url: string | null;
    cancel_url: string | null;
    bangla_qr_string: string | null;
    expires_at: string;
  }>(
    `SELECT id, status, mode, provider, account_mode, amount_bdt, requested_amount_bdt,
            unique_paisa_offset, reference_code, success_url, cancel_url, bangla_qr_string, expires_at
     FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ?`,
    [merchantId, idempotencyKey],
  );

  if (existing) {
    await logApiUsage(merchantId, '/api/v1/payments', 'POST', 200, started);
    res.status(200).json({
      idempotentReplay: true,
      paymentId: existing.id,
      merchantOrderId,
      mode: existing.mode,
      status: existing.status,
      provider: existing.provider,
      accountMode: existing.account_mode,
      requestedAmountBdt: existing.requested_amount_bdt ?? existing.amount_bdt,
      amountBdt: existing.amount_bdt,
      uniquePaisaOffset: existing.unique_paisa_offset ?? 0,
      referenceCode: existing.reference_code,
      successUrl: existing.success_url,
      cancelUrl: existing.cancel_url,
      banglaQrString: existing.bangla_qr_string,
      checkoutUrl: `${env.appUrl}/?checkout=${existing.id}`,
      expiresAt: existing.expires_at,
    });
    return;
  }

  // Resolve website context (by explicit websiteId or Origin/Referer domain)
  let website: {
    id: string;
    domain: string;
    success_url: string | null;
    cancel_url: string | null;
    mode: string;
    is_active: number;
  } | null = null;

  if (req.body?.websiteId) {
    website = await db.queryOne(
      'SELECT id, domain, success_url, cancel_url, mode, is_active FROM merchant_websites WHERE id = ? AND merchant_id = ?',
      [String(req.body.websiteId), merchantId],
    );
    if (!website || Number(website.is_active) !== 1) {
      await logApiUsage(merchantId, '/api/v1/payments', 'POST', 403, started);
      res.status(403).json({ error: 'Specified websiteId is inactive or does not belong to this merchant' });
      return;
    }
  } else {
    const originHeader = req.header('Origin') || req.header('Referer') || '';
    if (originHeader) {
      try {
        const hostname = new URL(originHeader).hostname.toLowerCase();
        website = await db.queryOne(
          'SELECT id, domain, success_url, cancel_url, mode, is_active FROM merchant_websites WHERE merchant_id = ? AND LOWER(domain) = ? AND is_active = 1 LIMIT 1',
          [merchantId, hostname],
        );
      } catch {
        // Ignore malformed Origin/Referer
      }
    }
  }

  const effectiveMode: 'LIVE' | 'TEST' =
    req.merchant!.mode === 'TEST' || website?.mode === 'TEST' || String(req.body?.mode ?? '').toUpperCase() === 'TEST'
      ? 'TEST'
      : 'LIVE';

  const wallet = requestedAccountMode
    ? (await db.queryOne<{ id: string; account_number: string; account_type: string }>(
        'SELECT id, account_number, account_type FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND account_type = ? AND is_active = 1 LIMIT 1',
        [merchantId, provider, requestedAccountMode],
      )) ??
      (await db.queryOne<{ id: string; account_number: string; account_type: string }>(
        'SELECT id, account_number, account_type FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
        [merchantId, provider],
      ))
    : await db.queryOne<{ id: string; account_number: string; account_type: string }>(
        'SELECT id, account_number, account_type FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
        [merchantId, provider],
      );

  const accountMode = wallet?.account_type ?? requestedAccountMode ?? 'MERCHANT';

  // Enforce SaaS Package Quota, Provider Access & Active Subscription
  try {
    await assertPaymentCreationAllowed(merchantId, {
      provider,
      accountType: accountMode,
      mode: effectiveMode,
    });
  } catch (err) {
    if (err instanceof EntitlementError) {
      await logApiUsage(merchantId, '/api/v1/payments', 'POST', err.statusCode, started);
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const { payableAmountBdt, paisaOffset } = await allocateMicroAmount(
    merchantId,
    provider,
    requestedAmountBdt,
    uniqueMicroAmount,
  );

  const successUrl = req.body?.successUrl ? String(req.body.successUrl).trim() : website?.success_url ?? null;
  const cancelUrl = req.body?.cancelUrl ? String(req.body.cancelUrl).trim() : website?.cancel_url ?? null;

  const id = newId();
  const now = isoNow();
  const expiresAt = isoNow(45 * 60_000);
  const referenceCode = `TL${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const banglaQrString =
    provider === 'BANGLA_QR'
      ? buildBanglaQrString({
          merchantName: req.merchant!.name,
          accountNumber: wallet?.account_number ?? '01700000000',
          amountBdt: payableAmountBdt,
          referenceCode,
        })
      : null;

  await db.execute(
    `INSERT INTO payment_intents (
      id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider,
      account_mode, mode, amount_bdt, requested_amount_bdt, unique_paisa_offset, currency,
      customer_name, customer_phone, customer_email, reference_code, success_url, cancel_url,
      bangla_qr_string, metadata_json, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    [
      id,
      merchantId,
      website?.id ?? null,
      wallet?.id ?? null,
      merchantOrderId,
      idempotencyKey,
      provider,
      accountMode,
      effectiveMode,
      payableAmountBdt,
      requestedAmountBdt,
      paisaOffset,
      customerName,
      customerPhone,
      customerEmail,
      referenceCode,
      successUrl,
      cancelUrl,
      banglaQrString,
      req.body?.metadata ? JSON.stringify(req.body.metadata) : null,
      expiresAt,
      now,
      now,
    ],
  );

  if (effectiveMode === 'LIVE') {
    await db.execute(
      `UPDATE merchant_subscriptions
       SET tx_used_current_period = tx_used_current_period + 1, updated_at = ?
       WHERE merchant_id = ? AND status IN ('ACTIVE', 'TRIAL')`,
      [now, merchantId],
    );
  }

  emitPaymentUpdated({
    paymentId: id,
    merchantId,
    status: 'PENDING',
    provider,
    amountBdt: payableAmountBdt,
  });

  await recordAuditLog({
    actorType: 'MERCHANT_API',
    actorId: merchantId,
    actorEmail: req.merchant!.slug,
    action: 'MERCHANT_API_PAYMENT_CREATED',
    resourceType: 'payment_intent',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: {
      merchantOrderId,
      websiteId: website?.id ?? null,
      mode: effectiveMode,
      provider,
      accountMode,
      requestedAmountBdt,
      payableAmountBdt,
      paisaOffset,
      idempotencyKey,
    },
  });

  await logApiUsage(merchantId, '/api/v1/payments', 'POST', 201, started);

  res.status(201).json({
    paymentId: id,
    merchantOrderId,
    websiteId: website?.id ?? null,
    mode: effectiveMode,
    status: 'PENDING',
    provider,
    accountMode,
    requestedAmountBdt,
    amountBdt: payableAmountBdt,
    uniquePaisaOffset: paisaOffset,
    currency: 'BDT',
    referenceCode,
    receiverWallet: wallet?.account_number ?? null,
    successUrl,
    cancelUrl,
    banglaQrString,
    checkoutUrl: `${env.appUrl}/?checkout=${id}`,
    expiresAt,
  });
});

merchantApiRoutes.get('/payments/:id', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_order_id: string;
    website_id: string | null;
    mode: string;
    provider: string;
    account_mode: string;
    amount_bdt: number;
    requested_amount_bdt: number | null;
    unique_paisa_offset: number;
    currency: string;
    status: string;
    submitted_trx_id: string | null;
    match_confidence: number | null;
    reference_code: string;
    verification_method: string | null;
    auto_verified: number;
    success_url: string | null;
    cancel_url: string | null;
    expires_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, merchant_order_id, website_id, mode, provider, account_mode, amount_bdt,
            requested_amount_bdt, unique_paisa_offset, currency, status, submitted_trx_id,
            match_confidence, reference_code, verification_method, auto_verified,
            success_url, cancel_url, expires_at, created_at, updated_at
     FROM payment_intents
     WHERE id = ? AND merchant_id = ?`,
    [req.params.id, req.merchant!.id],
  );

  if (!payment) {
    await logApiUsage(req.merchant!.id, '/api/v1/payments/:id', 'GET', 404, started);
    res.status(404).json({ error: 'Payment not found for merchant' });
    return;
  }

  const verification = await db.queryOne<{
    verification_source: string;
    provider_trx_id: string;
    documentary_evidence_ref: string;
    verified_at: string;
  }>(
    `SELECT verification_source, provider_trx_id, documentary_evidence_ref, verified_at
     FROM provider_verifications
     WHERE payment_intent_id = ? AND decision = 'VERIFIED'
     LIMIT 1`,
    [payment.id],
  );

  await logApiUsage(req.merchant!.id, '/api/v1/payments/:id', 'GET', 200, started);

  res.json({
    paymentId: payment.id,
    merchantOrderId: payment.merchant_order_id,
    websiteId: payment.website_id,
    mode: payment.mode,
    provider: payment.provider,
    accountMode: payment.account_mode,
    requestedAmountBdt: payment.requested_amount_bdt ?? payment.amount_bdt,
    amountBdt: payment.amount_bdt,
    uniquePaisaOffset: payment.unique_paisa_offset ?? 0,
    currency: payment.currency,
    status: payment.status,
    settled: payment.status === 'SUCCESS',
    autoVerified: Number(payment.auto_verified) === 1,
    verificationMethod: payment.verification_method,
    submittedTrxId: payment.submitted_trx_id,
    matchConfidence: payment.match_confidence,
    referenceCode: payment.reference_code,
    successUrl: payment.success_url,
    cancelUrl: payment.cancel_url,
    verification: verification ?? null,
    expiresAt: payment.expires_at,
  });
});

// Send Signed Test Webhook via Merchant API
merchantApiRoutes.post('/webhooks/test', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  try {
    const result = await sendMerchantTestWebhook({
      merchantId: req.merchant!.id,
      websiteId: req.body?.websiteId ? String(req.body.websiteId) : null,
      targetUrlOverride: req.body?.targetUrl ? String(req.body.targetUrl) : null,
      actorId: req.merchant!.id,
      actorEmail: req.merchant!.slug,
    });
    await logApiUsage(req.merchant!.id, '/api/v1/webhooks/test', 'POST', 200, started);
    res.json(result);
  } catch (err) {
    await logApiUsage(req.merchant!.id, '/api/v1/webhooks/test', 'POST', 400, started);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Test webhook dispatch failed' });
  }
});

// Programmatic Merchant Websites API
merchantApiRoutes.get('/merchant/websites', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  const db = getDb();
  const websites = await db.query(
    `SELECT id, site_name, domain, platform, callback_url, success_url, cancel_url,
            verification_token, verification_status, verified_at, mode, is_active, created_at
     FROM merchant_websites
     WHERE merchant_id = ?
     ORDER BY created_at DESC`,
    [req.merchant!.id],
  );
  await logApiUsage(req.merchant!.id, '/api/v1/merchant/websites', 'GET', 200, started);
  res.json({ websites });
});

merchantApiRoutes.post('/merchant/websites', requireMerchantApi, async (req: AuthedRequest, res) => {
  const started = Date.now();
  const merchantId = req.merchant!.id;
  const siteName = String(req.body?.siteName ?? '').trim();
  const domain = String(req.body?.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const platform = String(req.body?.platform ?? 'CUSTOM').toUpperCase();
  const callbackUrl = req.body?.callbackUrl ? String(req.body.callbackUrl).trim() : null;
  const successUrl = req.body?.successUrl ? String(req.body.successUrl).trim() : `https://${domain}/payment/success`;
  const cancelUrl = req.body?.cancelUrl ? String(req.body.cancelUrl).trim() : `https://${domain}/payment/cancel`;

  if (!siteName || !domain) {
    await logApiUsage(merchantId, '/api/v1/merchant/websites', 'POST', 400, started);
    res.status(400).json({ error: 'siteName and domain are required' });
    return;
  }

  try {
    await assertWebsiteQuota(merchantId);
  } catch (err) {
    if (err instanceof EntitlementError) {
      await logApiUsage(merchantId, '/api/v1/merchant/websites', 'POST', err.statusCode, started);
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const db = getDb();
  const id = newId();
  const verificationToken = `tl-verify-${generateSecretHex(8)}`;
  const now = isoNow();
  try {
    await db.execute(
      `INSERT INTO merchant_websites (
        id, merchant_id, site_name, domain, platform, callback_url, success_url, cancel_url,
        verification_token, verification_status, mode, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'LIVE', 1, ?)`,
      [id, merchantId, siteName, domain, platform, callbackUrl, successUrl, cancelUrl, verificationToken, now],
    );
  } catch (err) {
    await logApiUsage(merchantId, '/api/v1/merchant/websites', 'POST', 409, started);
    res.status(409).json({ error: err instanceof Error ? err.message : 'Domain already registered' });
    return;
  }

  await logApiUsage(merchantId, '/api/v1/merchant/websites', 'POST', 201, started);
  res.status(201).json({
    id,
    siteName,
    domain,
    platform,
    callbackUrl,
    successUrl,
    cancelUrl,
    verificationToken,
    verificationStatus: 'PENDING',
  });
});

// Versioned Android APK Pairing Alias (/api/v1/devices/pair)
merchantApiRoutes.post('/devices/pair', async (req, res) => {
  const pairingCode = String(req.body?.pairingCode ?? '').trim().toUpperCase();
  const deviceUid = String(req.body?.deviceUid ?? '').trim();
  const androidModel = String(req.body?.androidModel ?? 'Android Device').trim();
  const androidVersion = String(req.body?.androidVersion ?? 'Unknown').trim();
  const appVersion = String(req.body?.appVersion ?? '2.1.0').trim();
  const simSlots = Array.isArray(req.body?.simSlots) ? req.body.simSlots : [];

  if (!pairingCode || !deviceUid) {
    res.status(400).json({ error: 'pairingCode and deviceUid are required' });
    return;
  }

  const db = getDb();
  const device = await db.queryOne<{
    id: string;
    merchant_id: string | null;
    device_name: string;
    pairing_expires_at: string | null;
    assigned_providers_json: string;
    status: string;
  }>(
    'SELECT id, merchant_id, device_name, pairing_expires_at, assigned_providers_json, status FROM devices WHERE pairing_code = ?',
    [pairingCode],
  );

  if (!device || device.status !== 'PENDING_PAIRING') {
    res.status(404).json({ error: 'Invalid or already consumed pairing code' });
    return;
  }
  if (device.pairing_expires_at && new Date(device.pairing_expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    res.status(410).json({ error: 'Pairing code expired; request a new pairing code from Dashboard' });
    return;
  }

  const rawDeviceToken = `tldev_${generateSecretHex(24)}`;
  const rawHmacSecret = generateSecretHex(32);
  const now = isoNow();

  await db.execute(
    `UPDATE devices
     SET device_uid = ?, android_model = ?, android_version = ?, app_version = ?,
         sim_slots_json = ?, pairing_code = NULL, pairing_expires_at = NULL,
         device_token_hash = ?, hmac_secret_enc = ?,
         status = 'ACTIVE', last_heartbeat_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      deviceUid,
      androidModel,
      androidVersion,
      appVersion,
      JSON.stringify(simSlots),
      sha256Hex(rawDeviceToken),
      encryptSecret(rawHmacSecret),
      now,
      now,
      device.id,
    ],
  );

  emitDeviceTelemetry({
    deviceId: device.id,
    merchantId: device.merchant_id,
    status: 'ACTIVE',
    batteryPct: null,
    networkType: null,
    queueDepth: 0,
  });

  await recordAuditLog({
    actorType: 'DEVICE',
    actorId: device.id,
    actorEmail: deviceUid,
    action: 'DEVICE_PAIRED_ACTIVE',
    resourceType: 'device',
    resourceId: device.id,
    ipAddress: req.ip ?? null,
    afterState: { deviceUid, androidModel, androidVersion, appVersion, simSlots, endpoint: '/api/v1/devices/pair' },
  });

  res.json({
    deviceId: device.id,
    deviceName: device.device_name,
    merchantId: device.merchant_id,
    assignedProviders: JSON.parse(device.assigned_providers_json || '[]'),
    deviceToken: rawDeviceToken,
    hmacSecret: rawHmacSecret,
    ingestEndpoint: '/api/v1/notifications/ingest',
    batchIngestEndpoint: '/api/notifications/ingest-batch',
    heartbeatEndpoint: '/api/devices/heartbeat',
  });
});

// Versioned Android Notification Ingest Alias (/api/v1/notifications/ingest)
merchantApiRoutes.post('/notifications/ingest', requireDeviceAuth, async (req: AuthedRequest, res) => {
  const bodyText = String(req.body?.body ?? '').trim();
  const packageName = String(req.body?.packageName ?? 'unknown').trim();
  const eventUid = String(req.body?.eventUid ?? newId());
  const deviceTimestampMs = Number(req.body?.deviceTimestampMs ?? Date.now());
  const sourceChannel = req.body?.sourceChannel === 'SMS' ? 'SMS' : 'NOTIFICATION';
  const simSlot = req.body?.simSlot !== undefined && req.body?.simSlot !== null ? Number(req.body.simSlot) : null;

  if (!bodyText) {
    res.status(400).json({ error: 'Notification body is required' });
    return;
  }

  const result = await ingestDeviceNotification({
    deviceId: req.device!.id,
    merchantId: req.device!.merchantId,
    packageName,
    sourceChannel,
    simSlot,
    title: req.body?.title ? String(req.body.title) : null,
    body: bodyText,
    senderHeader: req.body?.senderHeader ? String(req.body.senderHeader) : null,
    eventUid,
    deviceTimestampMs,
    ipAddress: req.ip ?? null,
  });

  const db = getDb();
  await db.execute('UPDATE devices SET last_heartbeat_at = ? WHERE id = ?', [isoNow(), req.device!.id]);
  res.status(result.duplicate ? 200 : 201).json(result);
});
