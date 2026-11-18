import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireMerchantApi } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { newId } from '../utils/crypto.ts';

export const merchantApiRoutes = Router();

// Create Payment Intent via Merchant API (Idempotent)
merchantApiRoutes.post('/payments', requireMerchantApi, async (req: AuthedRequest, res) => {
  const merchantId = req.merchant!.id;
  const merchantOrderId = String(req.body?.merchantOrderId ?? '').trim();
  const idempotencyKey = String(req.header('Idempotency-Key') || req.body?.idempotencyKey || merchantOrderId).trim();
  const provider = String(req.body?.provider ?? '').toUpperCase();
  const amountBdt = Number(req.body?.amountBdt ?? 0);
  const customerName = req.body?.customerName ? String(req.body.customerName).trim() : null;
  const customerPhone = req.body?.customerPhone ? String(req.body.customerPhone).trim() : null;
  const customerEmail = req.body?.customerEmail ? String(req.body.customerEmail).trim() : null;

  if (!merchantOrderId || !['BKASH', 'NAGAD', 'ROCKET'].includes(provider) || !Number.isFinite(amountBdt) || amountBdt <= 0) {
    res.status(400).json({
      error: 'merchantOrderId, provider (BKASH|NAGAD|ROCKET), and positive amountBdt are required',
    });
    return;
  }

  const db = getDb();

  // Check idempotency key first
  const existing = await db.queryOne<{
    id: string;
    status: string;
    provider: string;
    amount_bdt: number;
    reference_code: string;
    expires_at: string;
  }>(
    'SELECT id, status, provider, amount_bdt, reference_code, expires_at FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ?',
    [merchantId, idempotencyKey],
  );

  if (existing) {
    res.status(200).json({
      idempotentReplay: true,
      paymentId: existing.id,
      merchantOrderId,
      status: existing.status,
      provider: existing.provider,
      amountBdt: existing.amount_bdt,
      referenceCode: existing.reference_code,
      checkoutUrl: `${env.appUrl}/?checkout=${existing.id}`,
      expiresAt: existing.expires_at,
    });
    return;
  }

  const wallet = await db.queryOne<{ id: string; account_number: string }>(
    'SELECT id, account_number FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
    [merchantId, provider],
  );

  const id = newId();
  const now = isoNow();
  const expiresAt = isoNow(45 * 60_000);
  const referenceCode = `TL${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await db.execute(
    `INSERT INTO payment_intents (
      id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt,
      currency, customer_name, customer_phone, customer_email, reference_code,
      metadata_json, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?)`,
    [
      id,
      merchantId,
      wallet?.id ?? null,
      merchantOrderId,
      idempotencyKey,
      provider,
      amountBdt,
      customerName,
      customerPhone,
      customerEmail,
      referenceCode,
      req.body?.metadata ? JSON.stringify(req.body.metadata) : null,
      expiresAt,
      now,
      now,
    ],
  );

  await recordAuditLog({
    actorType: 'MERCHANT_API',
    actorId: merchantId,
    actorEmail: req.merchant!.slug,
    action: 'MERCHANT_API_PAYMENT_CREATED',
    resourceType: 'payment_intent',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { merchantOrderId, provider, amountBdt, idempotencyKey },
  });

  res.status(201).json({
    paymentId: id,
    merchantOrderId,
    status: 'CREATED',
    provider,
    amountBdt,
    currency: 'BDT',
    referenceCode,
    receiverWallet: wallet?.account_number ?? null,
    checkoutUrl: `${env.appUrl}/?checkout=${id}`,
    expiresAt,
  });
});

merchantApiRoutes.get('/payments/:id', requireMerchantApi, async (req: AuthedRequest, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_order_id: string;
    provider: string;
    amount_bdt: number;
    currency: string;
    status: string;
    submitted_trx_id: string | null;
    match_confidence: number | null;
    reference_code: string;
    expires_at: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, merchant_order_id, provider, amount_bdt, currency, status,
            submitted_trx_id, match_confidence, reference_code, expires_at, created_at, updated_at
     FROM payment_intents
     WHERE id = ? AND merchant_id = ?`,
    [req.params.id, req.merchant!.id],
  );

  if (!payment) {
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

  res.json({
    paymentId: payment.id,
    merchantOrderId: payment.merchant_order_id,
    provider: payment.provider,
    amountBdt: payment.amount_bdt,
    currency: payment.currency,
    status: payment.status,
    settled: payment.status === 'VERIFIED_SETTLED',
    submittedTrxId: payment.submitted_trx_id,
    matchConfidence: payment.match_confidence,
    referenceCode: payment.reference_code,
    verification: verification ?? null,
    expiresAt: payment.expires_at,
  });
});
