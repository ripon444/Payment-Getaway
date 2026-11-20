import { Router } from 'express';
import QRCode from 'qrcode';
import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireDeviceAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { emitDeviceTelemetry } from '../realtime/socket.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { assertDeviceQuota, EntitlementError } from '../services/entitlementService.ts';
import {
  encryptSecret,
  generatePairingCode,
  generateSecretHex,
  newId,
  sha256Hex,
} from '../utils/crypto.ts';

export const deviceRoutes = Router();

deviceRoutes.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;

  const devices = await db.query<{
    id: string;
    merchant_id: string | null;
    merchant_name: string | null;
    device_uid: string | null;
    device_name: string;
    android_model: string | null;
    android_version: string | null;
    app_version: string | null;
    sim_slots_json: string | null;
    pairing_code: string | null;
    pairing_expires_at: string | null;
    assigned_providers_json: string;
    status: string;
    last_heartbeat_at: string | null;
    battery_pct: number | null;
    network_type: string | null;
    queue_depth: number;
    created_at: string;
  }>(
    `SELECT d.id, d.merchant_id, m.name AS merchant_name, d.device_uid, d.device_name,
            d.android_model, d.android_version, d.app_version, d.sim_slots_json, d.pairing_code,
            d.pairing_expires_at, d.assigned_providers_json, d.status, d.last_heartbeat_at,
            d.battery_pct, d.network_type, d.queue_depth, d.created_at
     FROM devices d
     LEFT JOIN merchants m ON m.id = d.merchant_id
     ${isScoped ? 'WHERE d.merchant_id = ?' : ''}
     ORDER BY d.created_at DESC`,
    isScoped ? [req.user!.merchantId!] : [],
  );

  const mappings = await db.query<{ device_id: string; wallet_id: string; provider: string; account_number: string; sim_slot: number | null }>(
    `SELECT dw.device_id, dw.wallet_id, w.provider, w.account_number, dw.sim_slot
     FROM device_wallets dw
     JOIN mfs_wallets w ON w.id = dw.wallet_id`,
  );

  const enriched = devices.map((d) => ({
    ...d,
    assignedProviders: JSON.parse(d.assigned_providers_json || '[]'),
    simSlots: JSON.parse(d.sim_slots_json || '[]'),
    assignedWallets: mappings.filter((m) => m.device_id === d.id),
  }));

  res.json({ devices: enriched });
});

deviceRoutes.post(
  '/pairing-code',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const deviceName = String(req.body?.deviceName ?? '').trim();
    const merchantId =
      req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId
        ? req.user!.merchantId
        : req.body?.merchantId
          ? String(req.body.merchantId)
          : null;
    const assignedProviders = Array.isArray(req.body?.assignedProviders)
      ? req.body.assignedProviders.map((p: unknown) => String(p).toUpperCase())
      : ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CELLFIN', 'BANGLA_QR', 'BANK_SMS'];
    const walletIds = Array.isArray(req.body?.walletIds) ? req.body.walletIds.map(String) : [];

    if (!deviceName) {
      res.status(400).json({ error: 'deviceName is required' });
      return;
    }

    if (merchantId) {
      try {
        await assertDeviceQuota(merchantId);
      } catch (err) {
        if (err instanceof EntitlementError) {
          res.status(err.statusCode).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }

    const db = getDb();
    const id = newId();
    const pairingCode = generatePairingCode();
    const expiresAt = isoNow(15 * 60_000);
    const now = isoNow();

    await db.execute(
      `INSERT INTO devices (
        id, merchant_id, device_name, pairing_code, pairing_expires_at,
        assigned_providers_json, status, queue_depth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING_PAIRING', 0, ?, ?)`,
      [id, merchantId, deviceName, pairingCode, expiresAt, JSON.stringify(assignedProviders), now, now],
    );

    for (const walletId of walletIds) {
      await db.execute(
        'INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)',
        [id, walletId, now],
      );
    }

    const qrPayload = JSON.stringify({
      gatewayUrl: env.appUrl,
      pairingCode,
      deviceId: id,
      deviceName,
      providers: assignedProviders,
    });
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 1, width: 240 });

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'DEVICE_PAIRING_INITIATED',
      resourceType: 'device',
      resourceId: id,
      ipAddress: req.ip ?? null,
      afterState: { deviceName, merchantId, assignedProviders, expiresAt },
    });

    res.status(201).json({
      deviceId: id,
      deviceName,
      pairingCode,
      expiresAt,
      qrPayload,
      qrDataUrl,
    });
  },
);

// Android Agent Pairing Handshake
deviceRoutes.post('/pair', async (req, res) => {
  const pairingCode = String(req.body?.pairingCode ?? '').trim().toUpperCase();
  const deviceUid = String(req.body?.deviceUid ?? '').trim();
  const androidModel = String(req.body?.androidModel ?? 'Android Device').trim();
  const androidVersion = String(req.body?.androidVersion ?? 'Unknown').trim();
  const appVersion = String(req.body?.appVersion ?? '2.0.0').trim();
  const simSlots = Array.isArray(req.body?.simSlots) ? req.body.simSlots : [];

  if (!pairingCode || !deviceUid) {
    res.status(400).json({ error: 'pairingCode and deviceUid are required' });
    return;
  }

  const db = getDb();
  const device = await db.queryOne<{
    id: string;
    merchant_id: string | null;
    device_name: string;
    pairing_expires_at: string | null;
    assigned_providers_json: string;
    status: string;
  }>(
    'SELECT id, merchant_id, device_name, pairing_expires_at, assigned_providers_json, status FROM devices WHERE pairing_code = ?',
    [pairingCode],
  );

  if (!device || device.status !== 'PENDING_PAIRING') {
    res.status(404).json({ error: 'Invalid or already consumed pairing code' });
    return;
  }

  if (device.pairing_expires_at && new Date(device.pairing_expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    res.status(410).json({ error: 'Pairing code expired; request a new pairing code from Dashboard' });
    return;
  }

  const rawDeviceToken = `tldev_${generateSecretHex(24)}`;
  const rawHmacSecret = generateSecretHex(32);
  const now = isoNow();

  await db.execute(
    `UPDATE devices
     SET device_uid = ?, android_model = ?, android_version = ?, app_version = ?,
         sim_slots_json = ?, pairing_code = NULL, pairing_expires_at = NULL,
         device_token_hash = ?, hmac_secret_enc = ?,
         status = 'ACTIVE', last_heartbeat_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      deviceUid,
      androidModel,
      androidVersion,
      appVersion,
      JSON.stringify(simSlots),
      sha256Hex(rawDeviceToken),
      encryptSecret(rawHmacSecret),
      now,
      now,
      device.id,
    ],
  );

  emitDeviceTelemetry({
    deviceId: device.id,
    merchantId: device.merchant_id,
    status: 'ACTIVE',
    batteryPct: null,
    networkType: null,
    queueDepth: 0,
  });

  await recordAuditLog({
    actorType: 'DEVICE',
    actorId: device.id,
    actorEmail: deviceUid,
    action: 'DEVICE_PAIRED_ACTIVE',
    resourceType: 'device',
    resourceId: device.id,
    ipAddress: req.ip ?? null,
    afterState: { deviceUid, androidModel, androidVersion, appVersion, simSlots },
  });

  res.json({
    deviceId: device.id,
    deviceName: device.device_name,
    merchantId: device.merchant_id,
    assignedProviders: JSON.parse(device.assigned_providers_json || '[]'),
    deviceToken: rawDeviceToken,
    hmacSecret: rawHmacSecret,
    ingestEndpoint: '/api/notifications/ingest-batch',
    heartbeatEndpoint: '/api/devices/heartbeat',
  });
});

deviceRoutes.post('/heartbeat', requireDeviceAuth, async (req: AuthedRequest, res) => {
  const batteryPct = req.body?.batteryPct !== undefined ? Number(req.body.batteryPct) : null;
  const networkType = req.body?.networkType ? String(req.body.networkType) : null;
  const appVersion = req.body?.appVersion ? String(req.body.appVersion) : null;
  const queueDepth = req.body?.queueDepth !== undefined ? Number(req.body.queueDepth) : 0;
  const simSlots = Array.isArray(req.body?.simSlots) ? JSON.stringify(req.body.simSlots) : null;

  const db = getDb();
  await db.execute(
    `UPDATE devices
     SET last_heartbeat_at = ?, battery_pct = COALESCE(?, battery_pct),
         network_type = COALESCE(?, network_type), app_version = COALESCE(?, app_version),
         queue_depth = ?, sim_slots_json = COALESCE(?, sim_slots_json), updated_at = ?
     WHERE id = ?`,
    [isoNow(), batteryPct, networkType, appVersion, queueDepth, simSlots, isoNow(), req.device!.id],
  );

  emitDeviceTelemetry({
    deviceId: req.device!.id,
    merchantId: req.device!.merchantId,
    status: req.device!.status,
    batteryPct,
    networkType,
    queueDepth,
  });

  res.json({ ok: true, serverTimeMs: Date.now(), status: req.device!.status });
});

deviceRoutes.patch(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{ id: string; merchant_id: string | null; status: string; device_name: string }>(
      'SELECT id, merchant_id, status, device_name FROM devices WHERE id = ?',
      [req.params.id],
    );
    if (!existing) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && existing.merchant_id !== req.user!.merchantId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const nextStatus = req.body?.status ? String(req.body.status).toUpperCase() : existing.status;
    if (!['PENDING_PAIRING', 'ACTIVE', 'SUSPENDED', 'REVOKED'].includes(nextStatus)) {
      res.status(400).json({ error: 'Invalid device status' });
      return;
    }

    const now = isoNow();
    await db.execute('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?', [
      nextStatus,
      now,
      existing.id,
    ]);

    if (Array.isArray(req.body?.walletIds)) {
      await db.execute('DELETE FROM device_wallets WHERE device_id = ?', [existing.id]);
      for (const walletId of req.body.walletIds) {
        await db.execute('INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)', [
          existing.id,
          String(walletId),
          now,
        ]);
      }
    }

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'DEVICE_UPDATED',
      resourceType: 'device',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      beforeState: { status: existing.status },
      afterState: { status: nextStatus },
    });

    res.json({ id: existing.id, status: nextStatus });
  },
);

deviceRoutes.post(
  '/:id/unpair',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS', 'MERCHANT_ADMIN'),
  async (req: AuthedRequest, res) => {
    const db = getDb();
    const existing = await db.queryOne<{ id: string; merchant_id: string | null; status: string }>(
      'SELECT id, merchant_id, status FROM devices WHERE id = ?',
      [req.params.id],
    );
    if (!existing) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (req.user!.role === 'MERCHANT_ADMIN' && existing.merchant_id !== req.user!.merchantId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const reason = req.body?.reason ? String(req.body.reason).trim() : 'Unpaired by account operator';
    const now = isoNow();
    await db.execute(
      `UPDATE devices
       SET status = 'REVOKED', device_token_hash = NULL, hmac_secret_enc = NULL,
           unpaired_at = ?, revoked_reason = ?, updated_at = ?
       WHERE id = ?`,
      [now, reason, now, existing.id],
    );

    emitDeviceTelemetry({
      deviceId: existing.id,
      merchantId: existing.merchant_id,
      status: 'REVOKED',
      batteryPct: null,
      networkType: null,
      queueDepth: 0,
    });

    await recordAuditLog({
      actorType: 'USER',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: 'DEVICE_UNPAIRED_REVOKED',
      resourceType: 'device',
      resourceId: existing.id,
      ipAddress: req.ip ?? null,
      beforeState: { status: existing.status },
      afterState: { status: 'REVOKED', reason },
    });

    res.json({ id: existing.id, status: 'REVOKED', unpairedAt: now, reason });
  },
);

