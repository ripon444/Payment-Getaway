import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';
import { getDb } from '../db/client.ts';
import { decryptSecret, sha256Hex, verifyHmacSha256 } from '../utils/crypto.ts';

export type UserRole = 'SUPER_ADMIN' | 'FINANCE_REVIEWER' | 'OPERATIONS' | 'MERCHANT_ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  merchantId: string | null;
}

export interface AuthedMerchant {
  id: string;
  name: string;
  slug: string;
  status: string;
  mode: 'LIVE' | 'TEST';
  autoVerifyPolicy: 'STRICT_API_ONLY' | 'DETERMINISTIC_PERSONAL_PROOF';
}

export interface AuthedDevice {
  id: string;
  merchantId: string | null;
  deviceUid: string | null;
  deviceName: string;
  status: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  merchant?: AuthedMerchant;
  device?: AuthedDevice;
  rawBodyString?: string;
}

export function signUserJwt(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      merchantId: user.merchantId,
    },
    env.jwtSecret,
    { expiresIn: '12h' },
  );
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as {
      sub: string;
      email: string;
      fullName: string;
      role: UserRole;
      merchantId: string | null;
    };
    const db = getDb();
    const userRow = await db.queryOne<{
      id: string;
      email: string;
      full_name: string;
      role: UserRole;
      merchant_id: string | null;
      is_active: number;
    }>('SELECT id, email, full_name, role, merchant_id, is_active FROM users WHERE id = ?', [decoded.sub]);

    if (!userRow || Number(userRow.is_active) !== 1) {
      res.status(401).json({ error: 'Account is inactive or missing' });
      return;
    }

    req.user = {
      id: userRow.id,
      email: userRow.email,
      fullName: userRow.full_name,
      role: userRow.role,
      merchantId: userRow.merchant_id,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
      return;
    }
    next();
  };
}

export async function requireMerchantApi(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header('Authorization') || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const apiKey = (req.header('X-Merchant-Key') || bearerKey || '').trim();

  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-Merchant-Key or Authorization: Bearer <apiKey> header' });
    return;
  }

  const db = getDb();
  const keyHash = sha256Hex(apiKey);
  const merchant = await db.queryOne<{
    id: string;
    name: string;
    slug: string;
    status: string;
    webhook_secret_enc: string | null;
    api_secret_enc: string | null;
    api_key_hash: string;
    test_api_key_hash: string | null;
    auto_verify_policy: string | null;
  }>(
    `SELECT id, name, slug, status, webhook_secret_enc, api_secret_enc,
            api_key_hash, test_api_key_hash, auto_verify_policy
     FROM merchants
     WHERE api_key_hash = ? OR test_api_key_hash = ?`,
    [keyHash, keyHash],
  );

  if (!merchant) {
    res.status(401).json({ error: 'Invalid merchant API key' });
    return;
  }
  if (merchant.status !== 'ACTIVE') {
    res.status(403).json({ error: `Merchant account is ${merchant.status}` });
    return;
  }

  // Optional X-Api-Secret header validation when supplied
  const providedSecret = req.header('X-Api-Secret');
  if (providedSecret && merchant.api_secret_enc) {
    try {
      const expectedApiSecret = decryptSecret(merchant.api_secret_enc);
      if (providedSecret.trim() !== expectedApiSecret) {
        res.status(401).json({ error: 'Invalid X-Api-Secret header' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Merchant secret validation error' });
      return;
    }
  }

  // Optional HMAC request signature verification when X-Merchant-Signature is provided
  const sigHeader = req.header('X-Merchant-Signature');
  const tsHeader = req.header('X-Merchant-Timestamp');
  if (sigHeader && merchant.webhook_secret_enc) {
    const ts = Number(tsHeader || 0);
    if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      res.status(401).json({ error: 'Merchant request timestamp expired' });
      return;
    }
    const secret = decryptSecret(merchant.webhook_secret_enc);
    const payload = `${ts}.${req.rawBodyString ?? JSON.stringify(req.body ?? {})}`;
    if (!verifyHmacSha256(secret, payload, sigHeader)) {
      res.status(401).json({ error: 'Invalid X-Merchant-Signature' });
      return;
    }
  }

  const keyMode: 'LIVE' | 'TEST' = merchant.test_api_key_hash === keyHash ? 'TEST' : 'LIVE';

  req.merchant = {
    id: merchant.id,
    name: merchant.name,
    slug: merchant.slug,
    status: merchant.status,
    mode: keyMode,
    autoVerifyPolicy:
      merchant.auto_verify_policy === 'STRICT_API_ONLY'
        ? 'STRICT_API_ONLY'
        : 'DETERMINISTIC_PERSONAL_PROOF',
  };
  next();
}

export async function requireDeviceAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header('Authorization') || '';
  const deviceToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const tsHeader = req.header('X-Device-Timestamp') || '';
  const sigHeader = req.header('X-Device-Signature') || '';

  if (!deviceToken) {
    res.status(401).json({ error: 'Missing device bearer token' });
    return;
  }

  const db = getDb();
  const device = await db.queryOne<{
    id: string;
    merchant_id: string | null;
    device_uid: string | null;
    device_name: string;
    status: string;
    hmac_secret_enc: string | null;
  }>(
    'SELECT id, merchant_id, device_uid, device_name, status, hmac_secret_enc FROM devices WHERE device_token_hash = ?',
    [sha256Hex(deviceToken)],
  );

  if (!device) {
    res.status(401).json({ error: 'Unknown or revoked device token' });
    return;
  }
  if (device.status !== 'ACTIVE') {
    res.status(403).json({ error: `Device is ${device.status}; ingestion rejected` });
    return;
  }

  if (!tsHeader || !sigHeader || !device.hmac_secret_enc) {
    res.status(401).json({ error: 'Missing X-Device-Timestamp or X-Device-Signature' });
    return;
  }

  const ts = Number(tsHeader);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
    res.status(401).json({ error: 'Device timestamp outside 5-minute replay window' });
    return;
  }

  const hmacSecret = decryptSecret(device.hmac_secret_enc);
  const rawBody = req.rawBodyString ?? JSON.stringify(req.body ?? {});
  const canonical = `${ts}.${rawBody}`;
  if (!verifyHmacSha256(hmacSecret, canonical, sigHeader)) {
    res.status(401).json({ error: 'Invalid device HMAC signature' });
    return;
  }

  req.device = {
    id: device.id,
    merchantId: device.merchant_id,
    deviceUid: device.device_uid,
    deviceName: device.device_name,
    status: device.status,
  };
  next();
}
