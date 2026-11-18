import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  VerificationError,
  verifyPaymentManually,
  verifyPaymentViaProviderApi,
} from '../services/verificationService.ts';
import { attemptWebhookDelivery } from '../services/webhookService.ts';
import { newId } from '../utils/crypto.ts';

export const paymentRoutes = Router();

paymentRoutes.get('/overview', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const filterSql = isScoped ? 'WHERE merchant_id = ?' : '';
  const filterParams = isScoped ? [req.user!.merchantId!] : [];

  const totals = await db.queryOne<{
    total_count: number;
    settled_volume_bdt: number;
    candidate_count: number;
    review_count: number;
    settled_count: number;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN status = 'VERIFIED_SETTLED' THEN amount_bdt ELSE 0 END), 0) AS settled_volume_bdt,
       SUM(CASE WHEN status = 'CANDIDATE_MATCHED' THEN 1 ELSE 0 END) AS candidate_count,
       SUM(CASE WHEN status = 'MANUAL_REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review_count,
       SUM(CASE WHEN status = 'VERIFIED_SETTLED' THEN 1 ELSE 0 END) AS settled_count
     FROM payment_intents
     ${filterSql}`,
    filterParams,
  );

  const byProvider = await db.query<{
    provider: string;
    total_count: number;
    settled_bdt: number;
    pending_verification_count: number;
  }>(
    `SELECT provider,
            COUNT(*) AS total_count,
            COALESCE(SUM(CASE WHEN status = 'VERIFIED_SETTLED' THEN amount_bdt ELSE 0 END), 0) AS settled_bdt,
            SUM(CASE WHEN status IN ('CANDIDATE_MATCHED', 'MANUAL_REVIEW_REQUIRED', 'CUSTOMER_SUBMITTED') THEN 1 ELSE 0 END) AS pending_verification_count
     FROM payment_intents
     ${filterSql}
     GROUP BY provider`,
    filterParams,
  );

  const deviceStats = await db.queryOne<{ active_devices: number; total_devices: number }>(
    `SELECT
       SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_devices,
       COUNT(*) AS total_devices
     FROM devices
     ${isScoped ? 'WHERE merchant_id = ?' : ''}`,
    filterParams,
  );

  const webhookStats = await db.queryOne<{ delivered: number; total: number }>(
    `SELECT
       SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
       COUNT(*) AS total
     FROM webhook_deliveries
     ${isScoped ? 'WHERE merchant_id = ?' : ''}`,
    filterParams,
  );

  const verificationQueue = await db.query(
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     WHERE p.status IN ('CANDIDATE_MATCHED', 'MANUAL_REVIEW_REQUIRED', 'CUSTOMER_SUBMITTED')
     ${isScoped ? 'AND p.merchant_id = ?' : ''}
     ORDER BY p.updated_at DESC
     LIMIT 10`,
    filterParams,
  );

  res.json({
    totals,
    byProvider,
    deviceStats,
    webhookStats,
    verificationQueue,
  });
});

paymentRoutes.get('/payments', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const status = req.query.status ? String(req.query.status).toUpperCase() : '';
  const provider = req.query.provider ? String(req.query.provider).toUpperCase() : '';
  const q = req.query.q ? String(req.query.q).trim() : '';

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (isScoped) {
    clauses.push('p.merchant_id = ?');
    params.push(req.user!.merchantId!);
  }
  if (status && status !== 'ALL') {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (provider && provider !== 'ALL') {
    clauses.push('p.provider = ?');
    params.push(provider);
  }
  if (q) {
    clauses.push(
      '(p.merchant_order_id LIKE ? OR p.submitted_trx_id LIKE ? OR p.customer_phone LIKE ? OR p.reference_code LIKE ?)',
    );
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query(
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number, w.account_type AS wallet_type
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT 150`,
    params,
  );

  res.json({ payments: rows });
});

paymentRoutes.get('/payments/:id', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    merchant_name: string;
    wallet_number: string | null;
    wallet_type: string | null;
  }>(
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number, w.account_type AS wallet_type
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     WHERE p.id = ?`,
    [req.params.id],
  );

  if (!payment) {
    res.status(404).json({ error: 'Payment intent not found' });
    return;
  }
  if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== payment.merchant_id) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const candidates = await db.query(
    `SELECT c.*, n.raw_body_redacted, n.parsed_trx_id, n.parsed_amount_bdt, n.parsed_sender_phone,
            n.parse_status, n.received_at, d.device_name
     FROM payment_match_candidates c
     JOIN notification_events n ON n.id = c.notification_event_id
     LEFT JOIN devices d ON d.id = n.device_id
     WHERE c.payment_intent_id = ?
     ORDER BY c.confidence_score DESC`,
    [payment.id],
  );

  const verifications = await db.query(
    `SELECT v.*, u.full_name AS verifier_name, u.email AS verifier_email
     FROM provider_verifications v
     LEFT JOIN users u ON u.id = v.verifier_user_id
     WHERE v.payment_intent_id = ?
     ORDER BY v.verified_at DESC`,
    [payment.id],
  );

  const webhooks = await db.query(
    'SELECT * FROM webhook_deliveries WHERE payment_intent_id = ? ORDER BY created_at DESC',
    [payment.id],
  );

  res.json({ payment, candidates, verifications, webhooks });
});

paymentRoutes.post('/payments', requireAuth, async (req: AuthedRequest, res) => {
  const merchantId =
    req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
      ? req.user!.merchantId
      : String(req.body?.merchantId ?? '');
  const provider = String(req.body?.provider ?? 'BKASH').toUpperCase();
  const amountBdt = Number(req.body?.amountBdt ?? 0);
  const merchantOrderId = String(req.body?.merchantOrderId ?? `ORD-${Date.now()}`).trim();
  const customerName = req.body?.customerName ? String(req.body.customerName).trim() : null;
  const customerPhone = req.body?.customerPhone ? String(req.body.customerPhone).trim() : null;

  if (!merchantId || !['BKASH', 'NAGAD', 'ROCKET'].includes(provider) || !Number.isFinite(amountBdt) || amountBdt <= 0) {
    res.status(400).json({ error: 'merchantId, valid provider, and positive amountBdt are required' });
    return;
  }

  const db = getDb();
  const wallet = await db.queryOne<{ id: string }>(
    'SELECT id FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
    [merchantId, provider],
  );

  const id = newId();
  const now = isoNow();
  const expiresAt = isoNow(45 * 60_000);
  const referenceCode = `TL${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await db.execute(
    `INSERT INTO payment_intents (
      id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt,
      currency, customer_name, customer_phone, reference_code, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, 'CREATED', ?, ?, ?)`,
    [
      id,
      merchantId,
      wallet?.id ?? null,
      merchantOrderId,
      `portal-${id}`,
      provider,
      amountBdt,
      customerName,
      customerPhone,
      referenceCode,
      expiresAt,
      now,
      now,
    ],
  );

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'PAYMENT_INTENT_CREATED',
    resourceType: 'payment_intent',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { merchantId, merchantOrderId, provider, amountBdt },
  });

  res.status(201).json({
    id,
    merchantOrderId,
    provider,
    amountBdt,
    referenceCode,
    checkoutUrl: `${env.appUrl}/?checkout=${id}`,
    status: 'CREATED',
  });
});

paymentRoutes.post(
  '/payments/:id/verify-manual',
  requireAuth,
  requireRole('SUPER_ADMIN', 'FINANCE_REVIEWER'),
  async (req: AuthedRequest, res) => {
    try {
      const result = await verifyPaymentManually({
        paymentId: req.params.id,
        verifierUserId: req.user!.id,
        verifierEmail: req.user!.email,
        providerTrxId: String(req.body?.providerTrxId ?? ''),
        verifiedAmountBdt: Number(req.body?.verifiedAmountBdt ?? 0),
        documentaryEvidenceRef: String(req.body?.documentaryEvidenceRef ?? ''),
        notes: String(req.body?.notes ?? ''),
        decision: req.body?.decision === 'REJECTED' ? 'REJECTED' : 'VERIFIED',
        ipAddress: req.ip ?? null,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof VerificationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Manual verification failed' });
    }
  },
);

paymentRoutes.post(
  '/payments/:id/verify-provider',
  requireAuth,
  requireRole('SUPER_ADMIN', 'FINANCE_REVIEWER', 'OPERATIONS'),
  async (req: AuthedRequest, res) => {
    try {
      const result = await verifyPaymentViaProviderApi({
        paymentId: req.params.id,
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        providerTrxId: String(req.body?.providerTrxId ?? ''),
        ipAddress: req.ip ?? null,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof VerificationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Provider API verification error' });
    }
  },
);

paymentRoutes.get('/webhooks', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const rows = await db.query(
    `SELECT w.*, m.name AS merchant_name, p.merchant_order_id
     FROM webhook_deliveries w
     JOIN merchants m ON m.id = w.merchant_id
     JOIN payment_intents p ON p.id = w.payment_intent_id
     ${isScoped ? 'WHERE w.merchant_id = ?' : ''}
     ORDER BY w.created_at DESC
     LIMIT 100`,
    isScoped ? [req.user!.merchantId!] : [],
  );
  res.json({ deliveries: rows });
});

paymentRoutes.post(
  '/webhooks/:id/retry',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const result = await attemptWebhookDelivery(req.params.id);
    res.json(result);
  },
);

paymentRoutes.get(
  '/audit-logs',
  requireAuth,
  requireRole('SUPER_ADMIN', 'FINANCE_REVIEWER'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const action = req.query.action ? String(req.query.action).trim() : '';
    const rows = await db.query(
      `SELECT * FROM audit_logs
       ${action ? 'WHERE action LIKE ?' : ''}
       ORDER BY created_at DESC
       LIMIT 150`,
      action ? [`%${action}%`] : [],
    );
    res.json({ logs: rows });
  },
);
