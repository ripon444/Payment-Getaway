import { Router } from 'express';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { encryptSecret, generateApiKey, generateSecretHex, newId } from '../utils/crypto.ts';

export const merchantRoutes = Router();

merchantRoutes.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const merchants = await db.query(
    `SELECT m.id, m.name, m.slug, m.business_type, m.contact_email, m.webhook_url,
            m.api_key_prefix, m.settlement_mode, m.status, m.created_at,
            (SELECT COUNT(*) FROM mfs_wallets w WHERE w.merchant_id = m.id AND w.is_active = 1) AS active_wallets,
            (SELECT COUNT(*) FROM payment_intents p WHERE p.merchant_id = m.id) AS total_payments
     FROM merchants m
     ${isScoped ? 'WHERE m.id = ?' : ''}
     ORDER BY m.created_at DESC`,
    isScoped ? [req.user!.merchantId!] : [],
  );

  const wallets = await db.query(
    `SELECT w.*, m.name AS merchant_name
     FROM mfs_wallets w
     JOIN merchants m ON m.id = w.merchant_id
     ${isScoped ? 'WHERE w.merchant_id = ?' : ''}
     ORDER BY w.provider, w.created_at DESC`,
    isScoped ? [req.user!.merchantId!] : [],
  );

  res.json({ merchants, wallets });
});

merchantRoutes.post('/', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  const contactEmail = String(req.body?.contactEmail ?? '').trim();
  const businessType = String(req.body?.businessType ?? 'ECOMMERCE').trim();
  const webhookUrl = req.body?.webhookUrl ? String(req.body.webhookUrl).trim() : null;

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
  const webhookSecret = generateSecretHex(24);
  const db = getDb();

  await db.execute(
    `INSERT INTO merchants (
      id, name, slug, business_type, contact_email, webhook_url, webhook_secret_enc,
      api_key_prefix, api_key_hash, allowed_ips_json, settlement_mode, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROVIDER_API_OR_MANUAL', 'ACTIVE', ?, ?)`,
    [
      id,
      name,
      slug,
      businessType,
      contactEmail,
      webhookUrl,
      encryptSecret(webhookSecret),
      apiKey.prefix,
      apiKey.hash,
      JSON.stringify(['0.0.0.0/0']),
      now,
      now,
    ],
  );

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'MERCHANT_CREATED',
    resourceType: 'merchant',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { name, slug, contactEmail, webhookUrl },
  });

  res.status(201).json({
    merchant: { id, name, slug, contactEmail, webhookUrl, apiKeyPrefix: apiKey.prefix, status: 'ACTIVE' },
    credentialsOnce: {
      apiKey: apiKey.rawKey,
      webhookSecret,
    },
  });
});

merchantRoutes.post('/:id/rotate-key', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
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
});

merchantRoutes.post('/:id/rotate-webhook-secret', requireAuth, requireRole('SUPER_ADMIN', 'MERCHANT_ADMIN'), async (req: AuthedRequest, res) => {
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
    await db.execute(
      'UPDATE merchants SET webhook_secret_enc = ?, updated_at = ? WHERE id = ?',
      [encryptSecret(webhookSecret), isoNow(), merchant.id],
    );
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
});

merchantRoutes.post('/wallets', requireAuth, requireRole('SUPER_ADMIN', 'OPERATIONS'), async (req: AuthedRequest, res) => {
  const merchantId = String(req.body?.merchantId ?? '');
  const provider = String(req.body?.provider ?? '').toUpperCase();
  const accountNumber = String(req.body?.accountNumber ?? '').trim();
  const accountType = String(req.body?.accountType ?? 'MERCHANT').toUpperCase();
  const accountTitle = String(req.body?.accountTitle ?? '').trim();
  const dailyLimitBdt = Number(req.body?.dailyLimitBdt ?? 250000);

  if (!merchantId || !['BKASH', 'NAGAD', 'ROCKET'].includes(provider) || !accountNumber || !accountTitle) {
    res.status(400).json({ error: 'merchantId, provider (BKASH/NAGAD/ROCKET), accountNumber, and accountTitle are required' });
    return;
  }

  const db = getDb();
  const id = newId();
  try {
    await db.execute(
      `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [id, merchantId, provider, accountNumber, accountType, accountTitle, dailyLimitBdt, isoNow()],
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
    afterState: { merchantId, provider, accountNumber, accountType },
  });

  res.status(201).json({ id, merchantId, provider, accountNumber, accountType, accountTitle, dailyLimitBdt });
});
