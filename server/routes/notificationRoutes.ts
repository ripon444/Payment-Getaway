import { Router } from 'express';
import { getDb, isoNow } from '../db/client.ts';
import { requireAuth, requireDeviceAuth, requireRole } from '../middleware/auth.ts';
import type { AuthedRequest } from '../middleware/auth.ts';
import { parseMfsNotification, registerDynamicBankTemplates } from '../parsers/index.ts';
import type { DynamicBankTemplate } from '../parsers/bankSmsParser.ts';
import { ingestDeviceNotification } from '../services/matchingEngine.ts';
import { newId } from '../utils/crypto.ts';

export const notificationRoutes = Router();

notificationRoutes.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const isScoped = req.user!.role === 'MERCHANT_ADMIN' && req.user!.merchantId;
  const rows = await db.query(
    `SELECT n.*, d.device_name, d.device_uid
     FROM notification_events n
     LEFT JOIN devices d ON d.id = n.device_id
     ${isScoped ? 'WHERE n.merchant_id = ?' : ''}
     ORDER BY n.received_at DESC
     LIMIT 120`,
    isScoped ? [req.user!.merchantId!] : [],
  );
  res.json({ notifications: rows });
});

notificationRoutes.post('/ingest', requireDeviceAuth, async (req: AuthedRequest, res) => {
  const bodyText = String(req.body?.body ?? '').trim();
  const packageName = String(req.body?.packageName ?? 'unknown').trim();
  const eventUid = String(req.body?.eventUid ?? newId());
  const deviceTimestampMs = Number(req.body?.deviceTimestampMs ?? Date.now());
  const sourceChannel = req.body?.sourceChannel === 'SMS' ? 'SMS' : 'NOTIFICATION';
  const simSlot = req.body?.simSlot !== undefined && req.body?.simSlot !== null ? Number(req.body.simSlot) : null;

  if (!bodyText) {
    res.status(400).json({ error: 'Notification body is required' });
    return;
  }

  const result = await ingestDeviceNotification({
    deviceId: req.device!.id,
    merchantId: req.device!.merchantId,
    packageName,
    sourceChannel,
    simSlot,
    title: req.body?.title ? String(req.body.title) : null,
    body: bodyText,
    senderHeader: req.body?.senderHeader ? String(req.body.senderHeader) : null,
    eventUid,
    deviceTimestampMs,
    ipAddress: req.ip ?? null,
  });

  const db = getDb();
  await db.execute('UPDATE devices SET last_heartbeat_at = ? WHERE id = ?', [isoNow(), req.device!.id]);

  res.status(result.duplicate ? 200 : 201).json(result);
});

notificationRoutes.post('/ingest-batch', requireDeviceAuth, async (req: AuthedRequest, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length === 0) {
    res.status(400).json({ error: 'events array is required' });
    return;
  }

  const results = [];
  for (const evt of events.slice(0, 100)) {
    const bodyText = String(evt?.body ?? '').trim();
    if (!bodyText) continue;
    const resItem = await ingestDeviceNotification({
      deviceId: req.device!.id,
      merchantId: req.device!.merchantId,
      packageName: String(evt?.packageName ?? 'unknown'),
      sourceChannel: evt?.sourceChannel === 'SMS' ? 'SMS' : 'NOTIFICATION',
      simSlot: evt?.simSlot !== undefined && evt?.simSlot !== null ? Number(evt.simSlot) : null,
      title: evt?.title ? String(evt.title) : null,
      body: bodyText,
      senderHeader: evt?.senderHeader ? String(evt.senderHeader) : null,
      eventUid: String(evt?.eventUid ?? newId()),
      deviceTimestampMs: Number(evt?.deviceTimestampMs ?? Date.now()),
      ipAddress: req.ip ?? null,
    });
    results.push({ eventUid: evt?.eventUid, ...resItem });
  }

  const db = getDb();
  await db.execute('UPDATE devices SET last_heartbeat_at = ?, queue_depth = 0 WHERE id = ?', [
    isoNow(),
    req.device!.id,
  ]);

  res.json({ processed: results.length, results });
});

notificationRoutes.post('/parse-preview', requireAuth, async (req: AuthedRequest, res) => {
  const db = getDb();
  const tplRows = await db.query<DynamicBankTemplate>(
    'SELECT bank_name, sender_id, amount_regex, trx_regex, account_regex FROM bank_sms_templates WHERE is_active = 1',
  );
  registerDynamicBankTemplates(tplRows);

  const packageName = String(req.body?.packageName ?? 'com.bKash.customerapp');
  const title = req.body?.title ? String(req.body.title) : null;
  const body = String(req.body?.body ?? '');
  const senderHeader = req.body?.senderHeader ? String(req.body.senderHeader) : null;

  const parsed = parseMfsNotification({ packageName, title, body, senderHeader });
  res.json({ parsed });
});

notificationRoutes.post(
  '/simulate-device-ingest',
  requireAuth,
  requireRole('SUPER_ADMIN', 'OPERATIONS'),
  async (req: AuthedRequest, res) => {
    const deviceId = String(req.body?.deviceId ?? '');
    const packageName = String(req.body?.packageName ?? 'com.bKash.customerapp');
    const title = req.body?.title ? String(req.body.title) : 'MFS Alert';
    const bodyText = String(req.body?.body ?? '').trim();
    const senderHeader = req.body?.senderHeader ? String(req.body.senderHeader) : null;
    const sourceChannel = req.body?.sourceChannel === 'SMS' ? 'SMS' : 'NOTIFICATION';

    if (!deviceId || !bodyText) {
      res.status(400).json({ error: 'deviceId and body are required' });
      return;
    }

    const db = getDb();
    const device = await db.queryOne<{ id: string; merchant_id: string | null; status: string }>(
      'SELECT id, merchant_id, status FROM devices WHERE id = ?',
      [deviceId],
    );
    if (!device) {
      res.status(404).json({ error: 'Selected Android device not found' });
      return;
    }
    if (device.status !== 'ACTIVE') {
      res.status(403).json({ error: `Device status is ${device.status}` });
      return;
    }

    const result = await ingestDeviceNotification({
      deviceId: device.id,
      merchantId: device.merchant_id,
      packageName,
      sourceChannel,
      senderHeader,
      title,
      body: bodyText,
      eventUid: `sim-${newId()}`,
      deviceTimestampMs: Date.now(),
      ipAddress: req.ip ?? null,
    });

    res.status(201).json(result);
  },
);
