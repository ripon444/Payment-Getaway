import crypto from 'node:crypto';
import { env } from '../config/env.ts';

function deriveAesKey(): Buffer {
  return crypto.createHash('sha256').update(env.webhookEncryptionKey).digest();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateApiKey(prefix = 'tl_live'): { rawKey: string; prefix: string; hash: string } {
  const random = crypto.randomBytes(24).toString('base64url');
  const rawKey = `${prefix}_${random}`;
  return {
    rawKey,
    prefix: rawKey.slice(0, 14),
    hash: sha256Hex(rawKey),
  };
}

export function generateSecretHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += chars[bytes[i] % chars.length];
    if (i === 3) out += '-';
  }
  return out;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveAesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveAesKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function signHmacSha256(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyHmacSha256(secret: string, payload: string, signatureHex: string): boolean {
  const expected = signHmacSha256(secret, payload);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHex.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildWebhookSignatureHeader(secret: string, rawBody: string, timestampSec?: number): string {
  const ts = timestampSec ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${rawBody}`;
  const sig = signHmacSha256(secret, signedPayload);
  return `t=${ts},v1=${sig}`;
}
