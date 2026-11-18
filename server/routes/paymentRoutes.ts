import os from 'node:os';
import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { emitPaymentUpdated } from '../realtime/socket.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  VerificationError,
  verifyPaymentManually,
  verifyPaymentViaProviderApi,
} from '../services/verificationService.ts';
import { attemptWebhookDelivery } from '../services/webhookService.ts';
import { buildBanglaQrString } from '../utils/banglaQr.ts';
import { newId } from '../utils/crypto.ts';

export const paymentRoutes = Router();

const VALID_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CELLFIN', 'BANGLA_QR', 'BANK_SMS'];

async function sweepExpiredSessions(): Promise<void> {
  const db = getDb();
  const now = isoNow();
  await db.execute(
    `UPDATE payment_intents
     SET status = 'EXPIRED', updated_at = ?
     WHERE status IN ('PENDING') AND expires_at < ?`,
    [now, now],
  );
}

paymentRoutes.get('/overview', requireAuth, async (req: AuthedRequest, res) => {
  await sweepExpiredSessions();
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const filterSql = isScoped ? 'WHERE merchant_id = ?' : '';
  const filterParams = isScoped ? [req.user!.merchantId!] : [];

  const totals = await db.queryOne<{
    total_count: number;
    settled_volume_bdt: number;
    pending_count: number;
    detected_count: number;
    matched_count: number;
    review_count: number;
    success_count: number;
    failed_count: number;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_bdt ELSE 0 END), 0) AS settled_volume_bdt,
       SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'DETECTED' THEN 1 ELSE 0 END) AS detected_count,
       SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) AS matched_count,
       SUM(CASE WHEN status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review_count,
       SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status IN ('FAILED', 'EXPIRED') THEN 1 ELSE 0 END) AS failed_count
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
            COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN amount_bdt ELSE 0 END), 0) AS settled_bdt,
            SUM(CASE WHEN status IN ('DETECTED', 'MATCHED', 'REVIEW_REQUIRED') THEN 1 ELSE 0 END) AS pending_verification_count
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

  const openFraudCount = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM fraud_alerts WHERE status = 'OPEN' ${isScoped ? 'AND merchant_id = ?' : ''}`,
    filterParams,
  );

  const verificationQueue = await db.query(
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     WHERE p.status IN ('MATCHED', 'REVIEW_REQUIRED', 'DETECTED')
     ${isScoped ? 'AND p.merchant_id = ?' : ''}
     ORDER BY p.updated_at DESC
     LIMIT 12`,
    filterParams,
  );

  res.json({
    totals,
    byProvider,
    deviceStats,
    webhookStats,
    openFraudAlerts: openFraudCount?.cnt ?? 0,
    verificationQueue,
  });
});

paymentRoutes.get('/payments', requireAuth, async (req: AuthedRequest, res) => {
  await sweepExpiredSessions();
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
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number, w.account_type AS wallet_type, w.bank_name AS wallet_bank_name
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
    `SELECT p.*, m.name AS merchant_name, w.account_number AS wallet_number, w.account_type AS wallet_type, w.bank_name AS wallet_bank_name
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
            n.parsed_receiver_account, n.parsed_bank_name, n.parser_module, n.source_channel,
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
  const accountMode = String(req.body?.accountMode ?? 'MERCHANT').toUpperCase();
  const amountBdt = Number(req.body?.amountBdt ?? 0);
  const merchantOrderId = String(req.body?.merchantOrderId ?? `ORD-${Date.now()}`).trim();
  const customerName = req.body?.customerName ? String(req.body.customerName).trim() : null;
  const customerPhone = req.body?.customerPhone ? String(req.body.customerPhone).trim() : null;
  const websiteId = req.body?.websiteId ? String(req.body.websiteId) : null;

  if (!merchantId || !VALID_PROVIDERS.includes(provider) || !Number.isFinite(amountBdt) || amountBdt <= 0) {
    res.status(400).json({ error: 'merchantId, valid provider, and positive amountBdt are required' });
    return;
  }

  const db = getDb();
  const merchant = await db.queryOne<{ name: string }>('SELECT name FROM merchants WHERE id = ?', [merchantId]);
  const wallet = await db.queryOne<{ id: string; account_number: string; account_type: string }>(
    'SELECT id, account_number, account_type FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
    [merchantId, provider],
  );

  const id = newId();
  const now = isoNow();
  const expiresAt = isoNow(45 * 60_000);
  const referenceCode = `TL${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const banglaQrString =
    provider === 'BANGLA_QR'
      ? buildBanglaQrString({
          merchantName: merchant?.name ?? 'TakaLedger Merchant',
          accountNumber: wallet?.account_number ?? '01700000000',
          amountBdt,
          referenceCode,
        })
      : null;

  await db.execute(
    `INSERT INTO payment_intents (
      id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode,
      amount_bdt, currency, customer_name, customer_phone, reference_code, bangla_qr_string,
      status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    [
      id,
      merchantId,
      websiteId,
      wallet?.id ?? null,
      merchantOrderId,
      `portal-${id}`,
      provider,
      wallet?.account_type ?? accountMode,
      amountBdt,
      customerName,
      customerPhone,
      referenceCode,
      banglaQrString,
      expiresAt,
      now,
      now,
    ],
  );

  emitPaymentUpdated({
    paymentId: id,
    merchantId,
    status: 'PENDING',
    provider,
    amountBdt,
  });

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'PAYMENT_SESSION_CREATED',
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
    banglaQrString,
    checkoutUrl: `${env.appUrl}/?checkout=${id}`,
    status: 'PENDING',
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

paymentRoutes.get('/providers', requireAuth, async (_req, res) => {
  const db = getDb();
  const providers = await db.query('SELECT * FROM providers_config ORDER BY provider_code ASC');
  const templates = await db.query('SELECT * FROM bank_sms_templates ORDER BY bank_name ASC');
  res.json({ providers, templates });
});

paymentRoutes.patch(
  '/providers/:code',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const isEnabled = req.body?.isEnabled ? 1 : 0;
    await db.execute('UPDATE providers_config SET is_enabled = ?, updated_at = ? WHERE provider_code = ?', [
      isEnabled,
      isoNow(),
      req.params.code.toUpperCase(),
    ]);
    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'PROVIDER_TOGGLED',
      resourceType: 'provider',
      resourceId: req.params.code.toUpperCase(),
      ipAddress: req.ip ?? null,
      afterState: { isEnabled },
    });
    res.json({ providerCode: req.params.code.toUpperCase(), isEnabled });
  },
);

paymentRoutes.post(
  '/bank-templates',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS'),
  async (req: AuthedRequest, res) => {
    const bankName = String(req.body?.bankName ?? '').trim();
    const senderId = String(req.body?.senderId ?? '').trim().toUpperCase();
    const providerCode = String(req.body?.providerCode ?? 'BANK_SMS').toUpperCase();
    const sampleSms = String(req.body?.sampleSms ?? '').trim();
    const amountRegex = String(req.body?.amountRegex ?? '(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)');
    const trxRegex = String(req.body?.trxRegex ?? '(?:Ref|TrxID|TxnID)\\s*[:#-]?\\s*([A-Z0-9-]{6,20})');
    const accountRegex = req.body?.accountRegex ? String(req.body.accountRegex) : 'A\\/C\\s*([*\\d]{4,18})';
    const banglaQrCapable = req.body?.banglaQrCapable ? 1 : 0;

    if (!bankName || !senderId || !sampleSms) {
      res.status(400).json({ error: 'bankName, senderId, and sampleSms are required' });
      return;
    }

    const db = getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO bank_sms_templates (id, bank_name, sender_id, provider_code, sample_sms, amount_regex, trx_regex, account_regex, bangla_qr_capable, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, bankName, senderId, providerCode, sampleSms, amountRegex, trxRegex, accountRegex, banglaQrCapable, isoNow()],
    );

    res.status(201).json({ id, bankName, senderId, providerCode });
  },
);

paymentRoutes.get('/fraud-alerts', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const alerts = await db.query(
    `SELECT f.*, m.name AS merchant_name
     FROM fraud_alerts f
     LEFT JOIN merchants m ON m.id = f.merchant_id
     ${isScoped ? 'WHERE f.merchant_id = ?' : ''}
     ORDER BY f.created_at DESC
     LIMIT 100`,
    isScoped ? [req.user!.merchantId!] : [],
  );
  res.json({ alerts });
});

paymentRoutes.patch(
  '/fraud-alerts/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'FINANCE_REVIEWER'),
  async (req: AuthedRequest, res) => {
    const status = String(req.body?.status ?? 'RESOLVED').toUpperCase();
    const db = getDb();
    await db.execute('UPDATE fraud_alerts SET status = ? WHERE id = ?', [status, req.params.id]);
    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'FRAUD_ALERT_UPDATED',
      resourceType: 'fraud_alert',
      resourceId: req.params.id,
      ipAddress: req.ip ?? null,
      afterState: { status },
    });
    res.json({ id: req.params.id, status });
  },
);

paymentRoutes.get('/usage-stats', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const logs = await db.query(
    `SELECT a.*, m.name AS merchant_name
     FROM api_usage_logs a
     JOIN merchants m ON m.id = a.merchant_id
     ${isScoped ? 'WHERE a.merchant_id = ?' : ''}
     ORDER BY a.created_at DESC
     LIMIT 100`,
    isScoped ? [req.user!.merchantId!] : [],
  );
  const summary = await db.query(
    `SELECT a.endpoint, COUNT(*) AS calls, AVG(a.latency_ms) AS avg_latency_ms
     FROM api_usage_logs a
     ${isScoped ? 'WHERE a.merchant_id = ?' : ''}
     GROUP BY a.endpoint`,
    isScoped ? [req.user!.merchantId!] : [],
  );
  res.json({ logs, summary });
});

paymentRoutes.get('/system-health', requireAuth, requireRole('SUPER_ADMIN', 'OPERATIONS', 'FINANCE_REVIEWER'), async (_req, res) => {
  const db = getDb();
  const mem = process.memoryUsage();
  const dbCheck = await db.queryOne<{ ok: number }>('SELECT 1 AS ok');
  res.json({
    ok: dbCheck?.ok === 1,
    dialect: db.dialect,
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    timestamp: new Date().toISOString(),
  });
});

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
