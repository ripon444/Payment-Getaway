import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  getMerchantEntitlements,
  sweepExpiredSubscriptions,
  type SubscriptionPackageRow,
} from '../services/entitlementService.ts';
import { generateSecretHex, newId } from '../utils/crypto.ts';

export const saasRoutes = Router();

function formatPackage(row: SubscriptionPackageRow) {
  let allowedProviders: string[] = [];
  try {
    allowedProviders = JSON.parse(row.allowed_providers_json || '[]') as string[];
  } catch {
    allowedProviders = ['BKASH', 'NAGAD', 'ROCKET'];
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    tagline: row.tagline,
    monthlyPriceBdt: Number(row.monthly_price_bdt),
    yearlyPriceBdt: Number(row.yearly_price_bdt),
    maxWebsites: Number(row.max_websites),
    maxDevices: Number(row.max_devices),
    monthlyTxLimit: Number(row.monthly_tx_limit),
    allowedProviders,
    allowPersonalWallets: Number(row.allow_personal_wallets) === 1,
    allowAutoMatching: Number(row.allow_auto_matching) === 1,
    allowWebhooks: Number(row.allow_webhooks) === 1,
    allowApiAccess: Number(row.allow_api_access) === 1,
    historyRetentionDays: Number(row.history_retention_days),
    supportLevel: row.support_level,
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order),
  };
}

// Public SaaS Pricing Matrix
saasRoutes.get('/packages', async (_req, res) => {
  const db = getDb();
  const rows = await db.query<SubscriptionPackageRow>(
    'SELECT * FROM subscription_packages WHERE is_active = 1 ORDER BY sort_order ASC, monthly_price_bdt ASC',
  );
  res.json({ packages: rows.map(formatPackage) });
});

// Super Admin: All Packages
saasRoutes.get('/admin/packages', requireAuth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  const db = getDb();
  const rows = await db.query<SubscriptionPackageRow>(
    'SELECT * FROM subscription_packages ORDER BY sort_order ASC, monthly_price_bdt ASC',
  );
  res.json({ packages: rows.map(formatPackage) });
});

// Super Admin: Create Package
saasRoutes.post('/admin/packages', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const name = String(req.body?.name ?? '').trim();
  const tagline = req.body?.tagline ? String(req.body.tagline).trim() : null;
  const monthlyPriceBdt = Number(req.body?.monthlyPriceBdt ?? 0);
  const yearlyPriceBdt = Number(req.body?.yearlyPriceBdt ?? monthlyPriceBdt * 10);
  const maxWebsites = Math.max(1, Number(req.body?.maxWebsites ?? 1));
  const maxDevices = Math.max(1, Number(req.body?.maxDevices ?? 1));
  const monthlyTxLimit = Math.max(50, Number(req.body?.monthlyTxLimit ?? 500));
  const allowedProviders = Array.isArray(req.body?.allowedProviders)
    ? req.body.allowedProviders.map((p: unknown) => String(p).toUpperCase())
    : ['BKASH', 'NAGAD', 'ROCKET'];
  const allowPersonalWallets = req.body?.allowPersonalWallets !== false ? 1 : 0;
  const allowAutoMatching = req.body?.allowAutoMatching !== false ? 1 : 0;
  const allowWebhooks = req.body?.allowWebhooks !== false ? 1 : 0;
  const allowApiAccess = req.body?.allowApiAccess !== false ? 1 : 0;
  const historyRetentionDays = Math.max(30, Number(req.body?.historyRetentionDays ?? 90));
  const supportLevel = String(req.body?.supportLevel ?? 'EMAIL_STANDARD').trim();
  const sortOrder = Number(req.body?.sortOrder ?? 10);

  if (!code || !name || !Number.isFinite(monthlyPriceBdt) || monthlyPriceBdt < 0) {
    res.status(400).json({ error: 'Valid code, name, and monthlyPriceBdt are required' });
    return;
  }

  const db = getDb();
  const id = newId();
  const now = isoNow();
  try {
    await db.execute(
      `INSERT INTO subscription_packages (
        id, code, name, tagline, monthly_price_bdt, yearly_price_bdt, max_websites, max_devices,
        monthly_tx_limit, allowed_providers_json, allow_personal_wallets, allow_auto_matching,
        allow_webhooks, allow_api_access, history_retention_days, support_level, is_active,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        code,
        name,
        tagline,
        monthlyPriceBdt,
        yearlyPriceBdt,
        maxWebsites,
        maxDevices,
        monthlyTxLimit,
        JSON.stringify(allowedProviders),
        allowPersonalWallets,
        allowAutoMatching,
        allowWebhooks,
        allowApiAccess,
        historyRetentionDays,
        supportLevel,
        sortOrder,
        now,
        now,
      ],
    );
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Package code already exists' });
    return;
  }

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'SAAS_PACKAGE_CREATED',
    resourceType: 'subscription_package',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { code, name, monthlyPriceBdt, maxWebsites, maxDevices, monthlyTxLimit },
  });

  const created = await db.queryOne<SubscriptionPackageRow>('SELECT * FROM subscription_packages WHERE id = ?', [id]);
  res.status(201).json({ package: created ? formatPackage(created) : null });
});

// Super Admin: Update Package
saasRoutes.patch('/admin/packages/:id', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const db = getDb();
  const existing = await db.queryOne<SubscriptionPackageRow>('SELECT * FROM subscription_packages WHERE id = ?', [
    req.params.id,
  ]);
  if (!existing) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const tagline = req.body?.tagline !== undefined ? String(req.body.tagline).trim() : existing.tagline;
  const monthlyPriceBdt =
    req.body?.monthlyPriceBdt !== undefined ? Number(req.body.monthlyPriceBdt) : Number(existing.monthly_price_bdt);
  const yearlyPriceBdt =
    req.body?.yearlyPriceBdt !== undefined ? Number(req.body.yearlyPriceBdt) : Number(existing.yearly_price_bdt);
  const maxWebsites = req.body?.maxWebsites !== undefined ? Number(req.body.maxWebsites) : Number(existing.max_websites);
  const maxDevices = req.body?.maxDevices !== undefined ? Number(req.body.maxDevices) : Number(existing.max_devices);
  const monthlyTxLimit =
    req.body?.monthlyTxLimit !== undefined ? Number(req.body.monthlyTxLimit) : Number(existing.monthly_tx_limit);
  const allowedProvidersJson = Array.isArray(req.body?.allowedProviders)
    ? JSON.stringify(req.body.allowedProviders.map((p: unknown) => String(p).toUpperCase()))
    : existing.allowed_providers_json;
  const allowPersonalWallets =
    req.body?.allowPersonalWallets !== undefined ? (req.body.allowPersonalWallets ? 1 : 0) : existing.allow_personal_wallets;
  const allowAutoMatching =
    req.body?.allowAutoMatching !== undefined ? (req.body.allowAutoMatching ? 1 : 0) : existing.allow_auto_matching;
  const allowWebhooks =
    req.body?.allowWebhooks !== undefined ? (req.body.allowWebhooks ? 1 : 0) : existing.allow_webhooks;
  const allowApiAccess =
    req.body?.allowApiAccess !== undefined ? (req.body.allowApiAccess ? 1 : 0) : existing.allow_api_access;
  const historyRetentionDays =
    req.body?.historyRetentionDays !== undefined
      ? Number(req.body.historyRetentionDays)
      : Number(existing.history_retention_days);
  const supportLevel =
    req.body?.supportLevel !== undefined ? String(req.body.supportLevel).trim() : existing.support_level;
  const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active;

  await db.execute(
    `UPDATE subscription_packages
     SET name = ?, tagline = ?, monthly_price_bdt = ?, yearly_price_bdt = ?, max_websites = ?,
         max_devices = ?, monthly_tx_limit = ?, allowed_providers_json = ?,
         allow_personal_wallets = ?, allow_auto_matching = ?, allow_webhooks = ?,
         allow_api_access = ?, history_retention_days = ?, support_level = ?, is_active = ?, updated_at = ?
     WHERE id = ?`,
    [
      name,
      tagline,
      monthlyPriceBdt,
      yearlyPriceBdt,
      maxWebsites,
      maxDevices,
      monthlyTxLimit,
      allowedProvidersJson,
      allowPersonalWallets,
      allowAutoMatching,
      allowWebhooks,
      allowApiAccess,
      historyRetentionDays,
      supportLevel,
      isActive,
      isoNow(),
      existing.id,
    ],
  );

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'SAAS_PACKAGE_UPDATED',
    resourceType: 'subscription_package',
    resourceId: existing.id,
    ipAddress: req.ip ?? null,
    afterState: { name, monthlyPriceBdt, yearlyPriceBdt, maxWebsites, maxDevices, monthlyTxLimit, isActive },
  });

  const updated = await db.queryOne<SubscriptionPackageRow>('SELECT * FROM subscription_packages WHERE id = ?', [
    existing.id,
  ]);
  res.json({ package: updated ? formatPackage(updated) : null });
});

// Super Admin: Subscription Revenue & Merchant Subscriptions Overview
saasRoutes.get(
  '/admin/subscriptions',
  requireAuth,
  requireRole('SUPER_ADMIN', 'FINANCE_REVIEWER'),
  async (_req, res) => {
    await sweepExpiredSubscriptions();
    const db = getDb();

    const subscriptions = await db.query(
      `SELECT s.*, m.name AS merchant_name, m.contact_email, m.status AS merchant_status,
              p.code AS package_code, p.name AS package_name, p.monthly_tx_limit, p.max_websites, p.max_devices
       FROM merchant_subscriptions s
       JOIN merchants m ON m.id = s.merchant_id
       JOIN subscription_packages p ON p.id = s.package_id
       ORDER BY s.updated_at DESC`,
    );

    const invoices = await db.query(
      `SELECT i.*, m.name AS merchant_name, p.name AS package_name
       FROM subscription_invoices i
       JOIN merchants m ON m.id = i.merchant_id
       JOIN subscription_packages p ON p.id = i.package_id
       ORDER BY i.created_at DESC
       LIMIT 100`,
    );

    const revenueStats = await db.queryOne<{
      total_revenue_bdt: number;
      paid_invoices: number;
      active_subs: number;
      trial_subs: number;
      expired_subs: number;
      mrr_bdt: number;
    }>(
      `SELECT
         COALESCE((SELECT SUM(amount_bdt) FROM subscription_invoices WHERE status = 'PAID'), 0) AS total_revenue_bdt,
         COALESCE((SELECT COUNT(*) FROM subscription_invoices WHERE status = 'PAID'), 0) AS paid_invoices,
         COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active_subs,
         COALESCE(SUM(CASE WHEN status = 'TRIAL' THEN 1 ELSE 0 END), 0) AS trial_subs,
         COALESCE(SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END), 0) AS expired_subs,
         COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN (CASE WHEN billing_cycle = 'YEARLY' THEN price_bdt / 12.0 ELSE price_bdt END) ELSE 0 END), 0) AS mrr_bdt
       FROM merchant_subscriptions`,
    );

    res.json({ subscriptions, invoices, revenueStats });
  },
);

// Super Admin: Suspend / Activate Merchant & Optionally Manage Subscription
saasRoutes.patch('/admin/merchants/:id/status', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const db = getDb();
  const merchant = await db.queryOne<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM merchants WHERE id = ?',
    [req.params.id],
  );
  if (!merchant) {
    res.status(404).json({ error: 'Merchant not found' });
    return;
  }

  const nextStatus = String(req.body?.status ?? merchant.status).toUpperCase();
  if (!['ACTIVE', 'SUSPENDED', 'PENDING'].includes(nextStatus)) {
    res.status(400).json({ error: 'Invalid merchant status (ACTIVE | SUSPENDED | PENDING)' });
    return;
  }

  const now = isoNow();
  await db.execute('UPDATE merchants SET status = ?, updated_at = ? WHERE id = ?', [nextStatus, now, merchant.id]);

  // Optional subscription override or extension
  if (req.body?.extendDays) {
    const extendDays = Math.max(1, Number(req.body.extendDays));
    const latestSub = await db.queryOne<{ id: string; current_period_end: string }>(
      'SELECT id, current_period_end FROM merchant_subscriptions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1',
      [merchant.id],
    );
    if (latestSub) {
      const baseMs = Math.max(Date.now(), new Date(latestSub.current_period_end.replace(' ', 'T') + 'Z').getTime());
      const newEnd = new Date(baseMs + extendDays * 86400_000).toISOString().slice(0, 23).replace('T', ' ');
      await db.execute(
        "UPDATE merchant_subscriptions SET status = 'ACTIVE', current_period_end = ?, updated_at = ? WHERE id = ?",
        [newEnd, now, latestSub.id],
      );
    }
  }

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: nextStatus === 'SUSPENDED' ? 'MERCHANT_SUSPENDED' : 'MERCHANT_STATUS_UPDATED',
    resourceType: 'merchant',
    resourceId: merchant.id,
    ipAddress: req.ip ?? null,
    beforeState: { status: merchant.status },
    afterState: { status: nextStatus, extendDays: req.body?.extendDays ?? null },
  });

  res.json({ id: merchant.id, name: merchant.name, status: nextStatus });
});

// Merchant Self-Service: Get Subscription Status, Quotas & Invoice History
saasRoutes.get('/merchant/subscription', requireAuth, async (req: AuthedRequest, res) => {
  const merchantId =
    req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
      ? req.user!.merchantId
      : String(req.query.merchantId ?? '');

  if (!merchantId) {
    res.status(400).json({ error: 'merchantId is required' });
    return;
  }

  const db = getDb();
  const entitlements = await getMerchantEntitlements(merchantId);
  const invoices = await db.query(
    `SELECT i.*, p.name AS package_name, p.code AS package_code
     FROM subscription_invoices i
     JOIN subscription_packages p ON p.id = i.package_id
     WHERE i.merchant_id = ?
     ORDER BY i.created_at DESC
     LIMIT 50`,
    [merchantId],
  );
  const packages = await db.query<SubscriptionPackageRow>(
    'SELECT * FROM subscription_packages WHERE is_active = 1 ORDER BY sort_order ASC',
  );

  res.json({
    entitlements,
    invoices,
    availablePackages: packages.map(formatPackage),
  });
});

// Merchant Self-Service: Subscribe / Upgrade / Renew Package
saasRoutes.post(
  '/merchant/subscription',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const merchantId =
      req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
        ? req.user!.merchantId
        : String(req.body?.merchantId ?? '');

    if (!merchantId) {
      res.status(400).json({ error: 'merchantId is required' });
      return;
    }

    const packageId = req.body?.packageId ? String(req.body.packageId) : '';
    const packageCode = req.body?.packageCode ? String(req.body.packageCode).toUpperCase() : '';
    const billingCycle = String(req.body?.billingCycle ?? 'MONTHLY').toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const paymentMethod = String(req.body?.paymentMethod ?? 'BKASH').toUpperCase();

    const db = getDb();
    const pkg = packageId
      ? await db.queryOne<SubscriptionPackageRow>('SELECT * FROM subscription_packages WHERE id = ? AND is_active = 1', [
          packageId,
        ])
      : await db.queryOne<SubscriptionPackageRow>('SELECT * FROM subscription_packages WHERE code = ? AND is_active = 1', [
          packageCode,
        ]);

    if (!pkg) {
      res.status(404).json({ error: 'Selected subscription package not found' });
      return;
    }

    const priceBdt = billingCycle === 'YEARLY' ? Number(pkg.yearly_price_bdt) : Number(pkg.monthly_price_bdt);
    const periodDays = billingCycle === 'YEARLY' ? 365 : 30;
    const now = isoNow();
    const periodEnd = isoNow(periodDays * 86400_000);
    const subId = newId();
    const invoiceId = newId();
    const invoiceNumber = `INV-${new Date().getFullYear()}-${generateSecretHex(3).toUpperCase()}`;

    await db.withTransaction(async (tx) => {
      await tx.execute(
        "UPDATE merchant_subscriptions SET status = 'CANCELLED', updated_at = ? WHERE merchant_id = ? AND status IN ('ACTIVE', 'TRIAL')",
        [now, merchantId],
      );

      await tx.execute(
        `INSERT INTO merchant_subscriptions (
          id, merchant_id, package_id, billing_cycle, status, price_bdt,
          current_period_start, current_period_end, tx_used_current_period, auto_renew, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 0, 1, ?, ?)`,
        [subId, merchantId, pkg.id, billingCycle, priceBdt, now, periodEnd, now, now],
      );

      await tx.execute(
        `INSERT INTO subscription_invoices (
          id, merchant_id, subscription_id, package_id, invoice_number, billing_cycle,
          amount_bdt, payment_method, status, paid_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?)`,
        [invoiceId, merchantId, subId, pkg.id, invoiceNumber, billingCycle, priceBdt, paymentMethod, now, now],
      );
    });

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_SUBSCRIPTION_ACTIVATED',
      resourceType: 'merchant_subscription',
      resourceId: subId,
      ipAddress: req.ip ?? null,
      afterState: { merchantId, packageCode: pkg.code, billingCycle, priceBdt, invoiceNumber },
    });

    const entitlements = await getMerchantEntitlements(merchantId);
    res.status(201).json({
      subscriptionId: subId,
      invoiceNumber,
      amountBdt: priceBdt,
      billingCycle,
      packageName: pkg.name,
      entitlements,
    });
  },
);

// Merchant Financial Report Export (CSV or JSON) — remains accessible even if subscription expired
saasRoutes.get('/merchant/reports/export', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const merchantId = isScoped
    ? req.user!.merchantId!
    : req.query.merchantId
      ? String(req.query.merchantId)
      : null;

  const format = String(req.query.format ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  const status = req.query.status ? String(req.query.status).toUpperCase() : '';
  const mode = req.query.mode ? String(req.query.mode).toUpperCase() : '';
  const provider = req.query.provider ? String(req.query.provider).toUpperCase() : '';

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (merchantId) {
    clauses.push('p.merchant_id = ?');
    params.push(merchantId);
  }
  if (status && status !== 'ALL') {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (mode && mode !== 'ALL') {
    clauses.push('p.mode = ?');
    params.push(mode);
  }
  if (provider && provider !== 'ALL') {
    clauses.push('p.provider = ?');
    params.push(provider);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<Record<string, unknown>>(
    `SELECT p.id, p.merchant_order_id, m.name AS merchant_name, p.mode, p.provider, p.account_mode,
            p.amount_bdt, p.requested_amount_bdt, p.unique_paisa_offset, p.currency, p.status,
            p.submitted_trx_id, p.customer_name, p.customer_phone, p.reference_code,
            p.verification_method, p.auto_verified, p.created_at, p.verified_at, p.settled_at
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT 2000`,
    params,
  );

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'MERCHANT_REPORT_EXPORTED',
    resourceType: 'payment_report',
    resourceId: merchantId ?? 'ALL',
    ipAddress: req.ip ?? null,
    afterState: { format, rowCount: rows.length, status, mode, provider },
  });

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="takaledger-report-${Date.now()}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: rows.length, records: rows });
    return;
  }

  const headers = [
    'id',
    'merchant_order_id',
    'merchant_name',
    'mode',
    'provider',
    'account_mode',
    'amount_bdt',
    'requested_amount_bdt',
    'unique_paisa_offset',
    'currency',
    'status',
    'submitted_trx_id',
    'customer_name',
    'customer_phone',
    'reference_code',
    'verification_method',
    'auto_verified',
    'created_at',
    'verified_at',
    'settled_at',
  ];
  const escapeCsv = (val: unknown) => {
    const str = val === null || val === undefined ? '' : String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csvLines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="takaledger-report-${Date.now()}.csv"`);
  res.send(csvLines.join('\n'));
});

// Merchant APK Setup & Download Info Hub
saasRoutes.get('/merchant/apk-info', requireAuth, async (_req, res) => {
  res.json({
    appName: 'TakaLedger Android Agent',
    latestVersion: '2.1.0',
    minAndroidSdk: 26,
    targetAndroidSdk: 35,
    packageId: 'bd.takaledger.agent',
    gatewayBaseUrl: env.appUrl,
    endpoints: {
      pair: `${env.appUrl}/api/v1/devices/pair`,
      ingest: `${env.appUrl}/api/v1/notifications/ingest`,
      ingestBatch: `${env.appUrl}/api/notifications/ingest-batch`,
      heartbeat: `${env.appUrl}/api/devices/heartbeat`,
    },
    supportedProviders: ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CELLFIN', 'BANGLA_QR', 'BANK_SMS'],
    securityFeatures: [
      'AES-256-GCM EncryptedSharedPreferences + Android Keystore credential storage',
      'HMAC-SHA256 signed requests with 5-minute replay timestamp guard',
      'Local Room offline event queue with automatic WorkManager sync',
      'Local OTP/PIN stripping before queue persistence',
      'Dual-SIM slot detection & merchant-scoped wallet isolation',
    ],
    buildGuide: 'Build release APK from /android-agent using ./gradlew assembleRelease (see DEPLOYMENT.md).',
  });
});
