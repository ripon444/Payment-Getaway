import { Router } from 'express';
import QRCode from 'qrcode';
import { getDb, isoNow } from '../db/client.ts';
import { normalizeBdPhone } from '../parsers/types.ts';
import { emitPaymentUpdated } from '../realtime/socket.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { buildBanglaQrString } from '../utils/banglaQr.ts';

export const checkoutRoutes = Router();

checkoutRoutes.get('/:id', async (req, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    merchant_name: string;
    merchant_order_id: string;
    provider: string;
    amount_bdt: number;
    currency: string;
    reference_code: string;
    bangla_qr_string: string | null;
    submitted_trx_id: string | null;
    submitted_sender_phone: string | null;
    status: string;
    expires_at: string;
    wallet_id: string | null;
    wallet_number: string | null;
    wallet_type: string | null;
    wallet_title: string | null;
  }>(
    `SELECT p.id, p.merchant_id, m.name AS merchant_name, p.merchant_order_id, p.provider,
            p.amount_bdt, p.currency, p.reference_code, p.bangla_qr_string, p.submitted_trx_id,
            p.submitted_sender_phone, p.status, p.expires_at,
            w.id AS wallet_id, w.account_number AS wallet_number, w.account_type AS wallet_type, w.account_title AS wallet_title
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     WHERE p.id = ?`,
    [req.params.id],
  );

  if (!payment) {
    res.status(404).json({ error: 'Checkout session not found' });
    return;
  }

  const availableWallets = await db.query<{
    id: string;
    provider: string;
    account_number: string;
    account_type: string;
    account_title: string;
    bank_name: string | null;
    bangla_qr_payload: string | null;
  }>(
    'SELECT id, provider, account_number, account_type, account_title, bank_name, bangla_qr_payload FROM mfs_wallets WHERE merchant_id = ? AND is_active = 1',
    [payment.merchant_id],
  );

  const activeWallet =
    availableWallets.find((w) => w.id === payment.wallet_id) ||
    availableWallets.find((w) => w.provider === payment.provider) ||
    null;

  const banglaQrWallet = availableWallets.find((w) => w.provider === 'BANGLA_QR');
  const banglaQrString =
    payment.bangla_qr_string ||
    buildBanglaQrString({
      merchantName: payment.merchant_name,
      accountNumber: banglaQrWallet?.account_number || activeWallet?.account_number || '01700000000',
      amountBdt: Number(payment.amount_bdt),
      referenceCode: payment.reference_code,
    });

  const qrContent =
    payment.provider === 'BANGLA_QR'
      ? banglaQrString
      : activeWallet
        ? `${payment.provider}:${activeWallet.account_number}?amount=${payment.amount_bdt}&ref=${payment.reference_code}`
        : banglaQrString;

  const qrDataUrl = await QRCode.toDataURL(qrContent, { margin: 1, width: 220 });
  const banglaQrDataUrl = await QRCode.toDataURL(banglaQrString, { margin: 1, width: 220 });

  res.json({
    checkout: {
      id: payment.id,
      merchantName: payment.merchant_name,
      merchantOrderId: payment.merchant_order_id,
      provider: payment.provider,
      amountBdt: payment.amount_bdt,
      currency: payment.currency,
      referenceCode: payment.reference_code,
      submittedTrxId: payment.submitted_trx_id,
      submittedSenderPhone: payment.submitted_sender_phone,
      status: payment.status,
      expiresAt: payment.expires_at,
      receiverWallet: activeWallet,
      availableWallets,
      qrDataUrl,
      banglaQrString,
      banglaQrDataUrl,
    },
  });
});

checkoutRoutes.post('/:id/submit', async (req, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    provider: string;
    amount_bdt: number;
    status: string;
  }>('SELECT id, merchant_id, provider, amount_bdt, status FROM payment_intents WHERE id = ?', [
    req.params.id,
  ]);

  if (!payment) {
    res.status(404).json({ error: 'Checkout session not found' });
    return;
  }
  if (payment.status === 'SUCCESS' || payment.status === 'FAILED' || payment.status === 'EXPIRED') {
    res.status(409).json({ error: `Payment is already ${payment.status}` });
    return;
  }

  const requestedProvider = req.body?.provider
    ? String(req.body.provider).toUpperCase()
    : payment.provider;
  const trxId = String(req.body?.trxId ?? '').trim().toUpperCase();
  const senderPhone = normalizeBdPhone(String(req.body?.senderPhone ?? '').trim());

  if (!trxId || trxId.length < 6) {
    res.status(400).json({ error: 'Valid Transaction / Reference ID (min 6 characters) is required' });
    return;
  }
  if (!senderPhone) {
    res.status(400).json({ error: 'Valid Bangladesh mobile number (01XXXXXXXXX) is required' });
    return;
  }

  // Prevent reusing an already verified TrxID
  const usedTrx = await db.queryOne<{ id: string }>(
    `SELECT id FROM provider_verifications
     WHERE provider_trx_id = ? AND decision = 'VERIFIED' LIMIT 1`,
    [trxId],
  );
  if (usedTrx) {
    res.status(409).json({ error: 'This Transaction ID has already been used for a verified settlement.' });
    return;
  }

  let walletIdClause = '';
  const now = isoNow();
  const params: (string | number | null)[] = [requestedProvider, trxId, senderPhone, now, now, now];

  if (requestedProvider !== payment.provider) {
    const newWallet = await db.queryOne<{ id: string }>(
      'SELECT id FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
      [payment.merchant_id, requestedProvider],
    );
    if (newWallet) {
      walletIdClause = ', wallet_id = ?';
      params.push(newWallet.id);
    }
  }

  // Check if an unlinked parsed notification already arrived for this TrxID
  const preArrivedNotif = await db.queryOne<{
    id: string;
    parsed_amount_bdt: number | null;
  }>(
    `SELECT id, parsed_amount_bdt
     FROM notification_events
     WHERE parsed_trx_id = ? AND parse_status = 'PARSED'
     LIMIT 1`,
    [trxId],
  );

  let nextStatus = 'DETECTED';
  let confidence: number | null = null;
  let matchedNotifId: string | null = null;

  if (preArrivedNotif && preArrivedNotif.parsed_amount_bdt !== null) {
    const diff = Math.abs(Number(preArrivedNotif.parsed_amount_bdt) - Number(payment.amount_bdt));
    if (diff < 0.01) {
      nextStatus = 'MATCHED';
      confidence = 90;
      matchedNotifId = preArrivedNotif.id;
    } else {
      nextStatus = 'REVIEW_REQUIRED';
      confidence = 50;
      matchedNotifId = preArrivedNotif.id;
    }
  }

  params.push(nextStatus, confidence, matchedNotifId, payment.id);

  await db.execute(
    `UPDATE payment_intents
     SET provider = ?, submitted_trx_id = ?, submitted_sender_phone = ?,
         submitted_at = ?, detected_at = COALESCE(detected_at, ?), updated_at = ? ${walletIdClause},
         status = ?, match_confidence = COALESCE(?, match_confidence),
         matched_notification_id = COALESCE(?, matched_notification_id)
     WHERE id = ?`,
    params,
  );

  emitPaymentUpdated({
    paymentId: payment.id,
    merchantId: payment.merchant_id,
    status: nextStatus,
    provider: requestedProvider,
    amountBdt: Number(payment.amount_bdt),
    matchConfidence: confidence,
  });

  await recordAuditLog({
    actorType: 'SYSTEM',
    actorId: 'checkout-portal',
    action: 'CUSTOMER_SUBMITTED_TRX_ID',
    resourceType: 'payment_intent',
    resourceId: payment.id,
    ipAddress: req.ip ?? null,
    afterState: { provider: requestedProvider, trxId, senderPhone, status: nextStatus },
  });

  res.json({
    paymentId: payment.id,
    status: nextStatus,
    submittedTrxId: trxId,
    message:
      nextStatus === 'MATCHED'
        ? 'Transaction ID matched incoming payment alert (MATCHED). Awaiting authoritative verification before SUCCESS.'
        : 'Transaction ID received (DETECTED). Awaiting notification match and verification.',
  });
});
