import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole, signUserJwt } from '../middleware/auth.ts';
import type { AuthedRequest, UserRole } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { encryptSecret, generateApiKey, generateSecretHex, newId } from '../utils/crypto.ts';

export const authRoutes = Router();

interface UserDbRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  merchant_id: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}

authRoutes.get('/dev-mode', (_req, res) => {
  res.json({ devQuickLoginEnabled: !env.isProduction });
});

authRoutes.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const db = getDb();
  const user = await db.queryOne<UserDbRow>('SELECT * FROM users WHERE LOWER(email) = ?', [email]);
  if (!user || Number(user.is_active) !== 1) {
    res.status(401).json({ error: 'Invalid credentials or inactive account' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await recordAuditLog({
      actorType: 'USER',
      actorId: user.id,
      actorEmail: user.email,
      action: 'LOGIN_FAILED',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  await db.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [isoNow(), user.id]);
  const authUser = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    merchantId: user.merchant_id,
  };
  const token = signUserJwt(authUser);

  await recordAuditLog({
    actorType: 'USER',
    actorId: user.id,
    actorEmail: user.email,
    action: 'LOGIN_SUCCESS',
    resourceType: 'user',
    resourceId: user.id,
    ipAddress: req.ip ?? null,
  });

  res.json({ token, user: authUser });
});

authRoutes.post('/dev-quick-login', async (req, res) => {
  if (env.isProduction) {
    res.status(404).json({ error: 'Not available in production' });
    return;
  }

  const requestedRole = String(req.body?.role ?? 'SUPER_ADMIN') as UserRole;
  const db = getDb();
  const user = await db.queryOne<UserDbRow>(
    'SELECT * FROM users WHERE role = ? AND is_active = 1 LIMIT 1',
    [requestedRole],
  );
  if (!user) {
    res.status(404).json({ error: `No active user with role ${requestedRole}` });
    return;
  }

  await db.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [isoNow(), user.id]);
  const authUser = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    merchantId: user.merchant_id,
  };
  const token = signUserJwt(authUser);

  await recordAuditLog({
    actorType: 'USER',
    actorId: user.id,
    actorEmail: user.email,
    action: 'DEV_SANDBOX_LOGIN',
    resourceType: 'user',
    resourceId: user.id,
    ipAddress: req.ip ?? null,
  });

  res.json({ token, user: authUser });
});

authRoutes.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

authRoutes.get('/users', requireAuth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  const db = getDb();
  const rows = await db.query<
    Omit<UserDbRow, 'password_hash'> & { merchant_name: string | null }
  >(
    `SELECT u.id, u.email, u.full_name, u.role, u.merchant_id, u.is_active, u.last_login_at, u.created_at,
            m.name AS merchant_name
     FROM users u
     LEFT JOIN merchants m ON m.id = u.merchant_id
     ORDER BY u.created_at DESC`,
  );
  res.json({ users: rows });
});

authRoutes.post('/users', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const fullName = String(req.body?.fullName ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = String(req.body?.role ?? 'OPERATIONS') as UserRole;
  const merchantId = req.body?.merchantId ? String(req.body.merchantId) : null;

  if (!email || !fullName || password.length < 8) {
    res.status(400).json({ error: 'Valid email, fullName, and password (min 8 chars) are required' });
    return;
  }
  if (!['SUPER_ADMIN', 'FINANCE_REVIEWER', 'OPERATIONS', 'MERCHANT_ADMIN'].includes(role)) {
    res.status(400).json({ error: 'Invalid RBAC role' });
    return;
  }

  const db = getDb();
  const existing = await db.queryOne('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existing) {
    res.status(409).json({ error: 'User with this email already exists' });
    return;
  }

  const id = newId();
  const now = isoNow();
  const passwordHash = await bcrypt.hash(password, 10);

  await db.execute(
    `INSERT INTO users (id, email, full_name, password_hash, role, merchant_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, email, fullName, passwordHash, role, merchantId, now, now],
  );

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'USER_CREATED',
    resourceType: 'user',
    resourceId: id,
    ipAddress: req.ip ?? null,
    afterState: { email, fullName, role, merchantId },
  });

  res.status(201).json({ id, email, fullName, role, merchantId, isActive: 1 });
});

authRoutes.patch('/users/:id', requireAuth, requireRole('SUPER_ADMIN'), async (req: AuthedRequest, res) => {
  const db = getDb();
  const target = await db.queryOne<UserDbRow>('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const role = req.body?.role ? (String(req.body.role) as UserRole) : target.role;
  const isActive =
    req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : target.is_active;

  await db.execute('UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?', [
    role,
    isActive,
    isoNow(),
    target.id,
  ]);

  await recordAuditLog({
    actorType: 'USER',
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    action: 'USER_UPDATED',
    resourceType: 'user',
    resourceId: target.id,
    ipAddress: req.ip ?? null,
    beforeState: { role: target.role, isActive: target.is_active },
    afterState: { role, isActive },
  });

  res.json({ id: target.id, role, isActive });
});

// Public SaaS Merchant Self-Service Registration
authRoutes.post('/register-merchant', async (req, res) => {
  const businessName = String(req.body?.businessName ?? '').trim();
  const fullName = String(req.body?.fullName ?? businessName).trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const businessType = String(req.body?.businessType ?? 'ECOMMERCE').trim().toUpperCase();
  const businessPhone = req.body?.businessPhone ? String(req.body.businessPhone).trim() : null;
  const businessAddress = req.body?.businessAddress ? String(req.body.businessAddress).trim() : null;
  const websiteDomain = req.body?.websiteDomain
    ? String(req.body.websiteDomain)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
    : '';
  const websiteName = String(req.body?.websiteName ?? businessName).trim();
  const platform = String(req.body?.platform ?? 'CUSTOM').toUpperCase();
  const packageCode = String(req.body?.packageCode ?? 'STARTER').trim().toUpperCase();
  const billingCycle = String(req.body?.billingCycle ?? 'MONTHLY').toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';

  if (!businessName || !email || !email.includes('@') || password.length < 8) {
    res.status(400).json({ error: 'Valid businessName, email, and password (min 8 characters) are required' });
    return;
  }

  const db = getDb();
  const existingEmail = await db.queryOne<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existingEmail) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  const pkg = await db.queryOne<{ id: string; code: string; name: string; monthly_price_bdt: number; yearly_price_bdt: number }>(
    'SELECT id, code, name, monthly_price_bdt, yearly_price_bdt FROM subscription_packages WHERE code = ? AND is_active = 1',
    [packageCode],
  );
  const fallbackPkg =
    pkg ??
    (await db.queryOne<{ id: string; code: string; name: string; monthly_price_bdt: number; yearly_price_bdt: number }>(
      'SELECT id, code, name, monthly_price_bdt, yearly_price_bdt FROM subscription_packages WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1',
    ));

  if (!fallbackPkg) {
    res.status(500).json({ error: 'No subscription packages are configured on the platform' });
    return;
  }

  const merchantId = newId();
  const userId = newId();
  const subId = newId();
  const now = isoNow();
  const trialEnd = isoNow(14 * 86400_000);

  const slug =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) +
    '-' +
    generateSecretHex(2);

  const liveKey = generateApiKey('tl_live');
  const testKey = generateApiKey('tl_test');
  const apiSecret = `tl_sec_${generateSecretHex(24)}`;
  const webhookSecret = generateSecretHex(24);
  const passwordHash = await bcrypt.hash(password, 10);

  let websiteId: string | null = null;
  let verificationToken: string | null = null;

  await db.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO merchants (
        id, name, slug, business_type, contact_email, business_phone, business_address,
        webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, api_secret_enc,
        test_api_key_prefix, test_api_key_hash, allowed_ips_json, settlement_mode,
        auto_verify_policy, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROVIDER_API_OR_MANUAL', 'DETERMINISTIC_PERSONAL_PROOF', 'ACTIVE', ?, ?)`,
      [
        merchantId,
        businessName,
        slug,
        businessType,
        email,
        businessPhone,
        businessAddress,
        websiteDomain ? `https://${websiteDomain}/api/takaledger-webhook` : null,
        encryptSecret(webhookSecret),
        liveKey.prefix,
        liveKey.hash,
        encryptSecret(apiSecret),
        testKey.prefix,
        testKey.hash,
        JSON.stringify(['0.0.0.0/0']),
        now,
        now,
      ],
    );

    await tx.execute(
      `INSERT INTO users (id, email, full_name, password_hash, role, merchant_id, is_active, last_login_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'MERCHANT_ADMIN', ?, 1, ?, ?, ?)`,
      [userId, email, fullName, passwordHash, merchantId, now, now, now],
    );

    await tx.execute(
      `INSERT INTO merchant_subscriptions (
        id, merchant_id, package_id, billing_cycle, status, price_bdt,
        current_period_start, current_period_end, tx_used_current_period, auto_renew, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'TRIAL', 0, ?, ?, 0, 0, ?, ?)`,
      [subId, merchantId, fallbackPkg.id, billingCycle, now, trialEnd, now, now],
    );

    if (websiteDomain) {
      websiteId = newId();
      verificationToken = `tl-verify-${generateSecretHex(8)}`;
      const validPlatform = ['WOOCOMMERCE', 'CUSTOM', 'SHOPIFY', 'LARAVEL'].includes(platform) ? platform : 'CUSTOM';
      await tx.execute(
        `INSERT INTO merchant_websites (
          id, merchant_id, site_name, domain, platform, callback_url, success_url, cancel_url,
          verification_token, verification_status, mode, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'LIVE', 1, ?)`,
        [
          websiteId,
          merchantId,
          websiteName,
          websiteDomain,
          validPlatform,
          `https://${websiteDomain}/api/takaledger-webhook`,
          `https://${websiteDomain}/payment/success`,
          `https://${websiteDomain}/payment/cancel`,
          verificationToken,
          now,
        ],
      );
    }
  });

  const authUser = {
    id: userId,
    email,
    fullName,
    role: 'MERCHANT_ADMIN' as UserRole,
    merchantId,
  };
  const token = signUserJwt(authUser);

  await recordAuditLog({
    actorType: 'USER',
    actorId: userId,
    actorEmail: email,
    action: 'MERCHANT_SELF_REGISTERED',
    resourceType: 'merchant',
    resourceId: merchantId,
    ipAddress: req.ip ?? null,
    afterState: { businessName, email, packageCode: fallbackPkg.code, websiteDomain: websiteDomain || null },
  });

  res.status(201).json({
    token,
    user: authUser,
    merchant: {
      id: merchantId,
      name: businessName,
      slug,
      email,
      packageCode: fallbackPkg.code,
      packageName: fallbackPkg.name,
      subscriptionStatus: 'TRIAL',
      trialEndsAt: trialEnd,
    },
    website: websiteId ? { id: websiteId, domain: websiteDomain, verificationToken, verificationStatus: 'PENDING' } : null,
    credentialsOnce: {
      liveApiKey: liveKey.rawKey,
      testApiKey: testKey.rawKey,
      apiSecret,
      webhookSecret,
    },
  });
});
