import dns from 'node:dns/promises';
import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import {
  assertWalletCreationAllowed,
  assertWebsiteQuota,
  EntitlementError,
} from '../services/entitlementService.ts';
import { sendMerchantTestWebhook } from '../services/webhookService.ts';
import { encryptSecret, generateApiKey, generateSecretHex, newId } from '../utils/crypto.ts';

export const merchantRoutes = Router();

const VALID_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CELLFIN', 'BANGLA_QR', 'BANK_SMS'];

merchantRoutes.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const scopedParams = isScoped ? [req.user!.merchantId!] : [];

  const merchants = await db.query(
    `SELECT m.id, m.name, m.slug, m.business_type, m.contact_email, m.business_phone, m.business_address,
            m.webhook_url, m.api_key_prefix, m.test_api_key_prefix, m.settlement_mode, m.auto_verify_policy,
            m.fee_percent, m.settled_balance_bdt, m.pending_balance_bdt, m.status, m.created_at,
            (SELECT COUNT(*) FROM mfs_wallets w WHERE w.merchant_id = m.id AND w.is_active = 1) AS active_wallets,
            (SELECT COUNT(*) FROM merchant_websites s WHERE s.merchant_id = m.id AND s.is_active = 1) AS active_websites,
            (SELECT COUNT(*) FROM payment_intents p WHERE p.merchant_id = m.id) AS total_payments,
            (SELECT p.name FROM merchant_subscriptions ms JOIN subscription_packages p ON p.id = ms.package_id WHERE ms.merchant_id = m.id ORDER BY CASE WHEN ms.status IN ('ACTIVE','TRIAL') THEN 0 ELSE 1 END, ms.created_at DESC LIMIT 1) AS package_name,
            (SELECT ms.status FROM merchant_subscriptions ms WHERE ms.merchant_id = m.id ORDER BY CASE WHEN ms.status IN ('ACTIVE','TRIAL') THEN 0 ELSE 1 END, ms.created_at DESC LIMIT 1) AS subscription_status,
            (SELECT ms.current_period_end FROM merchant_subscriptions ms WHERE ms.merchant_id = m.id ORDER BY CASE WHEN ms.status IN ('ACTIVE','TRIAL') THEN 0 ELSE 1 END, ms.created_at DESC LIMIT 1) AS subscription_ends_at
     FROM merchants m
     ${isScoped ? 'WHERE m.id = ?' : ''}
     ORDER BY m.created_at DESC`,
    scopedParams,
  );

  const wallets = await db.query(
    `SELECT w.*, m.name AS merchant_name
     FROM mfs_wallets w
     JOIN merchants m ON m.id = w.merchant_id
     ${isScoped ? 'WHERE w.merchant_id = ?' : ''}
     ORDER BY w.provider, w.created_at DESC`,
    scopedParams,
  );

  const websites = await db.query(
    `SELECT s.*, m.name AS merchant_name
     FROM merchant_websites s
     JOIN merchants m ON m.id = s.merchant_id
     ${isScoped ? 'WHERE s.merchant_id = ?' : ''}
     ORDER BY s.created_at DESC`,
    scopedParams,
  );

  res.json({ merchants, wallets, websites });
});

merchantRoutes.post('/', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  const contactEmail = String(req.body?.contactEmail ?? '').trim();
  const businessType = String(req.body?.businessType ?? 'ECOMMERCE').trim();
  const businessPhone = req.body?.businessPhone ? String(req.body.businessPhone).trim() : null;
  const businessAddress = req.body?.businessAddress ? String(req.body.businessAddress).trim() : null;
  const webhookUrl = req.body?.webhookUrl ? String(req.body.webhookUrl).trim() : null;
  const packageCode = String(req.body?.packageCode ?? 'STARTER').toUpperCase();

  if (!name || !contactEmail) {
    res.status(400).json({ error: 'Merchant name and contactEmail are required' });
    return;
  }

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') +
    '-' +
    generateSecretHex(2);

  const id = newId();
  const now = isoNow();
  const apiKey = generateApiKey('tl_live');
  const testApiKey = generateApiKey('tl_test');
  const apiSecret = `tl_sec_${generateSecretHex(24)}`;
  const webhookSecret = generateSecretHex(24);
  const db = getDb();

  await db.execute(
    `INSERT INTO merchants (
      id, name, slug, business_type, contact_email, business_phone, business_address,
      webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, api_secret_enc,
      test_api_key_prefix, test_api_key_hash, allowed_ips_json, settlement_mode,
      auto_verify_policy, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROVIDER_API_OR_MANUAL', 'DETERMINISTIC_PERSONAL_PROOF', 'ACTIVE', ?, ?)`,
    [
      id,
      name,
      slug,
      businessType,
      contactEmail,
      businessPhone,
      businessAddress,
      webhookUrl,
      encryptSecret(webhookSecret),
      apiKey.prefix,
      apiKey.hash,
      encryptSecret(apiSecret),
      testApiKey.prefix,
      testApiKey.hash,
      JSON.stringify(['0.0.0.0/0']),
      now,
      now,
    ],
  );

  const pkg = await db.queryOne<{ id: string; monthly_price_bdt: number }>(
    'SELECT id, monthly_price_bdt FROM subscription_packages WHERE code = ? LIMIT 1',
    [packageCode],
  );
  if (pkg) {
    await db.execute(
      `INSERT INTO merchant_subscriptions (
        id, merchant_id, package_id, billing_cycle, status, price_bdt,
        current_period_start, current_period_end, tx_used_current_period, auto_renew, created_at, updated_at
      ) VALUES (?, ?, ?, 'MONTHLY', 'ACTIVE', ?, ?, ?, 0, 1, ?, ?)`,
      [newId(), id, pkg.id, pkg.monthly_price_bdt, now, isoNow(30 * 86400_000), now, now],
    );
  }

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'MERCHANT_CREATED',
    resourceType: 'merchant',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { name, slug, contactEmail, webhookUrl, packageCode },
  });

  res.status(201).json({
    merchant: {
      id,
      name,
      slug,
      contactEmail,
      webhookUrl,
      apiKeyPrefix: apiKey.prefix,
      testApiKeyPrefix: testApiKey.prefix,
      status: 'ACTIVE',
    },
    credentialsOnce: {
      apiKey: apiKey.rawKey,
      testApiKey: testApiKey.rawKey,
      apiSecret,
      webhookSecret,
    },
  });
});

merchantRoutes.post(
  '/:id/rotate-key',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const db = getDb();
    const merchant = await db.queryOne<{ id: string; name: string }>('SELECT id, name FROM merchants WHERE id = ?', [
      req.params.id,
    ]);
    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const apiKey = generateApiKey('tl_live');
    await db.execute('UPDATE merchants SET api_key_prefix = ?, api_key_hash = ?, updated_at = ? WHERE id = ?', [
      apiKey.prefix,
      apiKey.hash,
      isoNow(),
      merchant.id,
    ]);

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_API_KEY_ROTATED',
      resourceType: 'merchant',
      resourceId: merchant.id,
      ipAddress: req.ip ?? null,
      afterState: { apiKeyPrefix: apiKey.prefix },
    });

    res.json({ apiKey: apiKey.rawKey, apiKeyPrefix: apiKey.prefix });
  },
);

merchantRoutes.post(
  '/:id/rotate-test-key',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const db = getDb();
    const merchant = await db.queryOne<{ id: string }>('SELECT id FROM merchants WHERE id = ?', [req.params.id]);
    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const testKey = generateApiKey('tl_test');
    await db.execute(
      'UPDATE merchants SET test_api_key_prefix = ?, test_api_key_hash = ?, updated_at = ? WHERE id = ?',
      [testKey.prefix, testKey.hash, isoNow(), merchant.id],
    );

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_TEST_KEY_ROTATED',
      resourceType: 'merchant',
      resourceId: merchant.id,
      ipAddress: req.ip ?? null,
      afterState: { testApiKeyPrefix: testKey.prefix },
    });

    res.json({ testApiKey: testKey.rawKey, testApiKeyPrefix: testKey.prefix });
  },
);

merchantRoutes.post(
  '/:id/rotate-api-secret',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const db = getDb();
    const merchant = await db.queryOne<{ id: string }>('SELECT id FROM merchants WHERE id = ?', [req.params.id]);
    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const apiSecret = `tl_sec_${generateSecretHex(24)}`;
    await db.execute('UPDATE merchants SET api_secret_enc = ?, updated_at = ? WHERE id = ?', [
      encryptSecret(apiSecret),
      isoNow(),
      merchant.id,
    ]);

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_API_SECRET_ROTATED',
      resourceType: 'merchant',
      resourceId: merchant.id,
      ipAddress: req.ip ?? null,
    });

    res.json({ apiSecret });
  },
);

merchantRoutes.post(
  '/:id/rotate-webhook-secret',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const merchant = await db.queryOne<{ id: string }>('SELECT id FROM merchants WHERE id = ?', [req.params.id]);
    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const webhookSecret = generateSecretHex(24);
    const webhookUrl = req.body?.webhookUrl !== undefined ? String(req.body.webhookUrl).trim() : undefined;

    if (webhookUrl !== undefined) {
      await db.execute(
        'UPDATE merchants SET webhook_url = ?, webhook_secret_enc = ?, updated_at = ? WHERE id = ?',
        [webhookUrl || null, encryptSecret(webhookSecret), isoNow(), merchant.id],
      );
    } else {
      await db.execute('UPDATE merchants SET webhook_secret_enc = ?, updated_at = ? WHERE id = ?', [
        encryptSecret(webhookSecret),
        isoNow(),
        merchant.id,
      ]);
    }

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_WEBHOOK_SECRET_ROTATED',
      resourceType: 'merchant',
      resourceId: merchant.id,
      ipAddress: req.ip ?? null,
    });

    res.json({ webhookSecret });
  },
);

merchantRoutes.patch(
  '/:id/settings',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const db = getDb();
    const merchant = await db.queryOne<{
      id: string;
      webhook_url: string | null;
      business_phone: string | null;
      business_address: string | null;
      auto_verify_policy: string;
    }>('SELECT id, webhook_url, business_phone, business_address, auto_verify_policy FROM merchants WHERE id = ?', [
      req.params.id,
    ]);
    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const webhookUrl = req.body?.webhookUrl !== undefined ? String(req.body.webhookUrl).trim() || null : merchant.webhook_url;
    const businessPhone =
      req.body?.businessPhone !== undefined ? String(req.body.businessPhone).trim() || null : merchant.business_phone;
    const businessAddress =
      req.body?.businessAddress !== undefined
        ? String(req.body.businessAddress).trim() || null
        : merchant.business_address;
    const autoVerifyPolicy = req.body?.autoVerifyPolicy
      ? String(req.body.autoVerifyPolicy).toUpperCase()
      : merchant.auto_verify_policy;

    if (!['STRICT_API_ONLY', 'DETERMINISTIC_PERSONAL_PROOF'].includes(autoVerifyPolicy)) {
      res.status(400).json({ error: 'Invalid autoVerifyPolicy' });
      return;
    }

    await db.execute(
      `UPDATE merchants
       SET webhook_url = ?, business_phone = ?, business_address = ?, auto_verify_policy = ?, updated_at = ?
       WHERE id = ?`,
      [webhookUrl, businessPhone, businessAddress, autoVerifyPolicy, isoNow(), merchant.id],
    );

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_SETTINGS_UPDATED',
      resourceType: 'merchant',
      resourceId: merchant.id,
      ipAddress: req.ip ?? null,
      afterState: { webhookUrl, businessPhone, autoVerifyPolicy },
    });

    res.json({ id: merchant.id, webhookUrl, businessPhone, businessAddress, autoVerifyPolicy });
  },
);

merchantRoutes.post(
  '/:id/test-webhook',
  requireAuth,
  requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== req.params.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const result = await sendMerchantTestWebhook({
        merchantId: req.params.id,
        websiteId: req.body?.websiteId ? String(req.body.websiteId) : null,
        targetUrlOverride: req.body?.targetUrl ? String(req.body.targetUrl) : null,
        actorId: req.user!.id,
        actorEmail: req.user!.email,
      });
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Test webhook failed' });
    }
  },
);

// MFS & Bank Wallets CRUD
merchantRoutes.post(
  '/wallets',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const merchantId =
      req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
        ? req.user!.merchantId
        : String(req.body?.merchantId ?? '');
    const provider = String(req.body?.provider ?? '').toUpperCase();
    const accountNumber = String(req.body?.accountNumber ?? '').trim();
    const accountType = String(req.body?.accountType ?? 'MERCHANT').toUpperCase();
    const accountTitle = String(req.body?.accountTitle ?? '').trim();
    const bankName = req.body?.bankName ? String(req.body.bankName).trim() : null;
    const dailyLimitBdt = Number(req.body?.dailyLimitBdt ?? 250000);

    if (!merchantId || !VALID_PROVIDERS.includes(provider) || !accountNumber || !accountTitle) {
      res.status(400).json({ error: 'merchantId, valid provider, accountNumber, and accountTitle are required' });
      return;
    }

    try {
      await assertWalletCreationAllowed(merchantId, { provider, accountType });
    } catch (err) {
      if (err instanceof EntitlementError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }

    const db = getDb();
    const id = newId();
    try {
      await db.execute(
        `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, bank_name, daily_limit_bdt, daily_received_bdt, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        [id, merchantId, provider, accountNumber, accountType, accountTitle, bankName, dailyLimitBdt, isoNow()],
      );
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Wallet already exists' });
      return;
    }

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MFS_WALLET_CREATED',
      resourceType: 'mfs_wallet',
      resourceId: id,
      ipAddress: req.ip ?? null,
      afterState: { merchantId, provider, accountNumber, accountType, bankName },
    });

    res.status(201).json({ id, merchantId, provider, accountNumber, accountType, accountTitle, bankName, dailyLimitBdt });
  },
);

merchantRoutes.patch(
  '/wallets/:walletId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{
      id: string;
      merchant_id: string;
      account_title: string;
      account_type: string;
      bank_name: string | null;
      daily_limit_bdt: number;
      is_active: number;
    }>('SELECT * FROM mfs_wallets WHERE id = ?', [req.params.walletId]);

    if (!existing) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== existing.merchant_id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const accountTitle = req.body?.accountTitle !== undefined ? String(req.body.accountTitle).trim() : existing.account_title;
    const accountType = req.body?.accountType !== undefined ? String(req.body.accountType).toUpperCase() : existing.account_type;
    const bankName = req.body?.bankName !== undefined ? String(req.body.bankName).trim() || null : existing.bank_name;
    const dailyLimitBdt = req.body?.dailyLimitBdt !== undefined ? Number(req.body.dailyLimitBdt) : existing.daily_limit_bdt;
    const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active;

    await db.execute(
      'UPDATE mfs_wallets SET account_title = ?, account_type = ?, bank_name = ?, daily_limit_bdt = ?, is_active = ? WHERE id = ?',
      [accountTitle, accountType, bankName, dailyLimitBdt, isActive, existing.id],
    );

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MFS_WALLET_UPDATED',
      resourceType: 'mfs_wallet',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      beforeState: { isActive: existing.is_active, dailyLimitBdt: existing.daily_limit_bdt },
      afterState: { accountTitle, accountType, dailyLimitBdt, isActive },
    });

    res.json({ id: existing.id, accountTitle, accountType, bankName, dailyLimitBdt, isActive });
  },
);

merchantRoutes.delete(
  '/wallets/:walletId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{ id: string; merchant_id: string; provider: string; account_number: string }>(
      'SELECT id, merchant_id, provider, account_number FROM mfs_wallets WHERE id = ?',
      [req.params.walletId],
    );
    if (!existing) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== existing.merchant_id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await db.execute('DELETE FROM mfs_wallets WHERE id = ?', [existing.id]);

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MFS_WALLET_DELETED',
      resourceType: 'mfs_wallet',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      beforeState: existing,
    });

    res.json({ deleted: true, id: existing.id });
  },
);

// Merchant Websites CRUD + Domain Verification
merchantRoutes.post(
  '/websites',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const merchantId =
      req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
        ? req.user!.merchantId
        : String(req.body?.merchantId ?? '');
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
    const mode = String(req.body?.mode ?? 'LIVE').toUpperCase() === 'TEST' ? 'TEST' : 'LIVE';

    if (!merchantId || !siteName || !domain) {
      res.status(400).json({ error: 'merchantId, siteName, and domain are required' });
      return;
    }

    try {
      await assertWebsiteQuota(merchantId);
    } catch (err) {
      if (err instanceof EntitlementError) {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 1, ?)`,
        [id, merchantId, siteName, domain, platform, callbackUrl, successUrl, cancelUrl, verificationToken, mode, now],
      );
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Domain already registered for merchant' });
      return;
    }

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_WEBSITE_ADDED',
      resourceType: 'merchant_website',
      resourceId: id,
      ipAddress: req.ip ?? null,
      afterState: { merchantId, siteName, domain, platform, mode },
    });

    res.status(201).json({
      id,
      merchantId,
      siteName,
      domain,
      platform,
      callbackUrl,
      successUrl,
      cancelUrl,
      verificationToken,
      verificationStatus: 'PENDING',
      mode,
    });
  },
);

merchantRoutes.patch(
  '/websites/:siteId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{
      id: string;
      merchant_id: string;
      site_name: string;
      callback_url: string | null;
      success_url: string | null;
      cancel_url: string | null;
      enabled_providers_json: string | null;
      mode: string;
      is_active: number;
    }>('SELECT * FROM merchant_websites WHERE id = ?', [req.params.siteId]);

    if (!existing) {
      res.status(404).json({ error: 'Website not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== existing.merchant_id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const siteName = req.body?.siteName !== undefined ? String(req.body.siteName).trim() : existing.site_name;
    const callbackUrl = req.body?.callbackUrl !== undefined ? String(req.body.callbackUrl).trim() || null : existing.callback_url;
    const successUrl = req.body?.successUrl !== undefined ? String(req.body.successUrl).trim() || null : existing.success_url;
    const cancelUrl = req.body?.cancelUrl !== undefined ? String(req.body.cancelUrl).trim() || null : existing.cancel_url;
    const mode = req.body?.mode ? (String(req.body.mode).toUpperCase() === 'TEST' ? 'TEST' : 'LIVE') : existing.mode;
    const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active;
    const enabledProvidersJson = Array.isArray(req.body?.enabledProviders)
      ? JSON.stringify(req.body.enabledProviders.map((p: unknown) => String(p).toUpperCase()))
      : existing.enabled_providers_json;

    await db.execute(
      `UPDATE merchant_websites
       SET site_name = ?, callback_url = ?, success_url = ?, cancel_url = ?, enabled_providers_json = ?, mode = ?, is_active = ?
       WHERE id = ?`,
      [siteName, callbackUrl, successUrl, cancelUrl, enabledProvidersJson, mode, isActive, existing.id],
    );

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_WEBSITE_UPDATED',
      resourceType: 'merchant_website',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      afterState: { siteName, mode, callbackUrl, successUrl, cancelUrl, isActive },
    });

    res.json({ id: existing.id, siteName, callbackUrl, successUrl, cancelUrl, mode, isActive });
  },
);

merchantRoutes.post(
  '/websites/:siteId/verify',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const site = await db.queryOne<{
      id: string;
      merchant_id: string;
      domain: string;
      verification_token: string | null;
      verification_status: string;
    }>('SELECT id, merchant_id, domain, verification_token, verification_status FROM merchant_websites WHERE id = ?', [
      req.params.siteId,
    ]);

    if (!site) {
      res.status(404).json({ error: 'Website not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== site.merchant_id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const token = site.verification_token || `tl-verify-${generateSecretHex(8)}`;
    const method = String(req.body?.method ?? 'SANDBOX_CONFIRM').toUpperCase();
    let verified = false;
    let detail = '';

    if (method === 'DNS_TXT') {
      try {
        const records = await dns.resolveTxt(site.domain);
        const flat = records.flat().join(' ');
        if (flat.includes(token)) {
          verified = true;
          detail = `DNS TXT record matched ${token}`;
        } else {
          detail = `TXT record does not contain ${token}`;
        }
      } catch (err) {
        detail = err instanceof Error ? err.message : 'DNS TXT lookup failed';
      }
    } else if (method === 'HTML_META' || method === 'HTTP_FILE') {
      try {
        const url =
          method === 'HTTP_FILE'
            ? `https://${site.domain}/.well-known/takaledger-verify.txt`
            : `https://${site.domain}/`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        const body = await resp.text();
        if (resp.ok && body.includes(token)) {
          verified = true;
          detail = `${method} check matched token`;
        } else {
          detail = `Token ${token} not found at ${url} (HTTP ${resp.status})`;
        }
      } catch (err) {
        detail = err instanceof Error ? err.message : 'HTTP fetch failed';
      }
    } else if (method === 'SANDBOX_CONFIRM' || (!env.isProduction && req.body?.confirmToken === token) || req.user!.role === 'SUPER_ADMIN') {
      verified = true;
      detail = req.user!.role === 'SUPER_ADMIN' ? 'Verified by Super Admin' : 'Verified via token handshake';
    }

    if (!verified) {
      res.status(422).json({
        verified: false,
        verificationStatus: site.verification_status,
        expectedToken: token,
        error: detail || 'Domain ownership verification did not match token',
      });
      return;
    }

    const now = isoNow();
    await db.execute(
      `UPDATE merchant_websites
       SET verification_token = ?, verification_status = 'VERIFIED', verified_at = ?
       WHERE id = ?`,
      [token, now, site.id],
    );

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_WEBSITE_VERIFIED',
      resourceType: 'merchant_website',
      resourceId: site.id,
      ipAddress: req.ip ?? null,
      afterState: { domain: site.domain, method, detail },
    });

    res.json({
      id: site.id,
      domain: site.domain,
      verified: true,
      verificationStatus: 'VERIFIED',
      verifiedAt: now,
      detail,
    });
  },
);

merchantRoutes.delete(
  '/websites/:siteId',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{ id: string; merchant_id: string; domain: string }>(
      'SELECT id, merchant_id, domain FROM merchant_websites WHERE id = ?',
      [req.params.siteId],
    );
    if (!existing) {
      res.status(404).json({ error: 'Website not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId !== existing.merchant_id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await db.execute('DELETE FROM merchant_websites WHERE id = ?', [existing.id]);

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'MERCHANT_WEBSITE_DELETED',
      resourceType: 'merchant_website',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      beforeState: existing,
    });

    res.json({ deleted: true, id: existing.id });
  },
);
