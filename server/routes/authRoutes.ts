import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireRole, signUserJwt } from '../middleware/auth.ts';
import type { AuthedRequest, UserRole } from '../middleware/auth.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { newId } from '../utils/crypto.ts';

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
