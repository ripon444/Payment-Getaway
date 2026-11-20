import { Router } from 'express';
import QRCode from 'qrcode';
import { getDb, isoNow } from '../db/client.ts';
import { normalizeBdPhone } from '../parsers/types.ts';
import { emitPaymentUpdated } from '../realtime/socket.ts';
import { recordAuditLog } from '../services/auditService.ts';
import { reconcilePreArrivedNotificationForIntent } from '../services/matchingEngine.ts';
import { dispatchMerchantWebhook } from '../services/webhookService.ts';
import { buildBanglaQrString } from '../utils/banglaQr.ts';
import { newId } from '../utils/crypto.ts';

export const checkoutRoutes = Router();

checkoutRoutes.get('/:id', async (req, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    merchant_name: string;
    website_id: string | null;
    website_domain: string | null;
    website_success_url: string | null;
    website_cancel_url: string | null;
    merchant_order_id: string;
    provider: string;
    account_mode: string;
    mode: string;
    amount_bdt: number;
    requested_amount_bdt: number | null;
    unique_paisa_offset: number;
    currency: string;
    reference_code: string;
    success_url: string | null;
    cancel_url: string | null;
    verification_method: string | null;
    auto_verified: number;
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
    `SELECT p.id, p.merchant_id, m.name AS merchant_name, p.website_id,
            mw.domain AS website_domain, mw.success_url AS website_success_url, mw.cancel_url AS website_cancel_url,
            p.merchant_order_id, p.provider, p.account_mode, p.mode, p.amount_bdt,
            p.requested_amount_bdt, p.unique_paisa_offset, p.currency, p.reference_code,
            p.success_url, p.cancel_url, p.verification_method, p.auto_verified,
            p.bangla_qr_string, p.submitted_trx_id, p.submitted_sender_phone, p.status, p.expires_at,
            w.id AS wallet_id, w.account_number AS wallet_number, w.account_type AS wallet_type, w.account_title AS wallet_title
     FROM payment_intents p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN merchant_websites mw ON mw.id = p.website_id
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
      websiteDomain: payment.website_domain,
      merchantOrderId: payment.merchant_order_id,
      provider: payment.provider,
      accountMode: payment.account_mode,
      mode: payment.mode,
      amountBdt: payment.amount_bdt,
      requestedAmountBdt: payment.requested_amount_bdt ?? payment.amount_bdt,
      uniquePaisaOffset: payment.unique_paisa_offset ?? 0,
      currency: payment.currency,
      referenceCode: payment.reference_code,
      successUrl: payment.success_url || payment.website_success_url,
      cancelUrl: payment.cancel_url || payment.website_cancel_url,
      verificationMethod: payment.verification_method,
      autoVerified: Number(payment.auto_verified) === 1,
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

// Zero-TrxID Checkout Confirmation (NO Transaction ID & NO Screenshot required)
checkoutRoutes.post('/:id/confirm-sent', async (req, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    merchant_order_id: string;
    provider: string;
    mode: string;
    amount_bdt: number;
    status: string;
    success_url: string | null;
  }>(
    'SELECT id, merchant_id, merchant_order_id, provider, mode, amount_bdt, status, success_url FROM payment_intents WHERE id = ?',
    [req.params.id],
  );

  if (!payment) {
    res.status(404).json({ error: 'Checkout session not found' });
    return;
  }
  if (payment.status === 'SUCCESS') {
    res.json({
      paymentId: payment.id,
      status: 'SUCCESS',
      successUrl: payment.success_url,
      message: 'Payment is verified and settled.',
    });
    return;
  }
  if (payment.status === 'FAILED' || payment.status === 'EXPIRED') {
    res.status(409).json({ error: `Payment is already ${payment.status}` });
    return;
  }

  const requestedProvider = req.body?.provider
    ? String(req.body.provider).toUpperCase()
    : payment.provider;

  const rawSender = String(req.body?.senderPhone ?? '').trim();
  const senderPhone = rawSender ? normalizeBdPhone(rawSender) : null;
  if (rawSender && !senderPhone) {
    res.status(400).json({ error: 'If provided, senderPhone must be a valid Bangladesh mobile number (01XXXXXXXXX)' });
    return;
  }

  const now = isoNow();

  // Test Mode Sandbox instant simulation (explicitly scoped ONLY to mode === 'TEST')
  if (payment.mode === 'TEST' && req.body?.testSimulateSuccess === true) {
    const simTrxId = `TEST${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    await db.execute(
      `UPDATE payment_intents
       SET provider = ?, submitted_sender_phone = COALESCE(?, submitted_sender_phone),
           submitted_trx_id = ?, verification_method = 'SANDBOX_TEST_SIMULATION',
           auto_verified = 1, status = 'SUCCESS', verified_at = ?, settled_at = ?, updated_at = ?
       WHERE id = ?`,
      [requestedProvider, senderPhone, simTrxId, now, now, now, payment.id],
    );

    emitPaymentUpdated({
      paymentId: payment.id,
      merchantId: payment.merchant_id,
      status: 'SUCCESS',
      provider: requestedProvider,
      amountBdt: Number(payment.amount_bdt),
      matchConfidence: 100,
    });

    await recordAuditLog({
      actorType: 'SYSTEM',
      actorId: 'checkout-sandbox',
      action: 'TEST_MODE_PAYMENT_SIMULATED_SUCCESS',
      resourceType: 'payment_intent',
      resourceId: payment.id,
      ipAddress: req.ip ?? null,
      afterState: { mode: 'TEST', provider: requestedProvider, simTrxId },
    });

    await dispatchMerchantWebhook({
      merchantId: payment.merchant_id,
      paymentIntentId: payment.id,
      eventType: 'payment.verified_settled',
      payload: {
        paymentId: payment.id,
        merchantOrderId: payment.merchant_order_id,
        mode: 'TEST',
        status: 'SUCCESS',
        provider: requestedProvider,
        amountBdt: payment.amount_bdt,
        trxId: simTrxId,
        verificationMethod: 'SANDBOX_TEST_SIMULATION',
        verifiedAt: now,
      },
    });

    res.json({
      paymentId: payment.id,
      status: 'SUCCESS',
      mode: 'TEST',
      successUrl: payment.success_url,
      message: 'Test Mode payment simulated cleanly (SUCCESS). No real ledger balance was altered.',
    });
    return;
  }

  let walletIdClause = '';
  const updateParams: (string | number | null)[] = [requestedProvider, senderPhone, now, now];

  if (requestedProvider !== payment.provider) {
    const newWallet = await db.queryOne<{ id: string }>(
      'SELECT id FROM mfs_wallets WHERE merchant_id = ? AND provider = ? AND is_active = 1 LIMIT 1',
      [payment.merchant_id, requestedProvider],
    );
    if (newWallet) {
      walletIdClause = ', wallet_id = ?, account_mode = COALESCE((SELECT account_type FROM mfs_wallets WHERE id = ?), account_mode)';
      updateParams.push(newWallet.id, newWallet.id);
    }
  }

  updateParams.push(payment.id);
  await db.execute(
    `UPDATE payment_intents
     SET provider = ?, submitted_sender_phone = COALESCE(?, submitted_sender_phone),
         status = CASE WHEN status = 'PENDING' THEN 'DETECTED' ELSE status END,
         detected_at = COALESCE(detected_at, ?), updated_at = ? ${walletIdClause}
     WHERE id = ?`,
    updateParams,
  );

  // Immediately check if an Android notification/SMS already arrived for this exact amount & wallet
  const reconciled = await reconcilePreArrivedNotificationForIntent(payment.id);

  const refreshed = await db.queryOne<{ status: string }>(
    'SELECT status FROM payment_intents WHERE id = ?',
    [payment.id],
  );
  const currentStatus = refreshed?.status ?? reconciled.status;

  if (!reconciled.matched) {
    emitPaymentUpdated({
      paymentId: payment.id,
      merchantId: payment.merchant_id,
      status: currentStatus,
      provider: requestedProvider,
      amountBdt: Number(payment.amount_bdt),
    });
  }

  await recordAuditLog({
    actorType: 'SYSTEM',
    actorId: 'checkout-zero-trxid',
    action: 'CUSTOMER_ZERO_TRXID_CONFIRM_SENT',
    resourceType: 'payment_intent',
    resourceId: payment.id,
    ipAddress: req.ip ?? null,
    afterState: { provider: requestedProvider, senderPhone, status: currentStatus },
  });

  res.json({
    paymentId: payment.id,
    status: currentStatus,
    successUrl: payment.success_url,
    message:
      currentStatus === 'SUCCESS'
        ? 'Payment automatically verified via incoming Android SMS/Notification (SUCCESS).'
        : currentStatus === 'MATCHED'
          ? 'Payment alert matched and awaiting verification.'
          : 'Listening for automatic incoming MFS SMS/Notification verification. No TrxID needed.',
  });
});

// Customer Cancel Checkout -> redirects to merchant cancelUrl
checkoutRoutes.post('/:id/cancel', async (req, res) => {
  const db = getDb();
  const payment = await db.queryOne<{
    id: string;
    merchant_id: string;
    provider: string;
    amount_bdt: number;
    status: string;
    cancel_url: string | null;
  }>(
    'SELECT id, merchant_id, provider, amount_bdt, status, cancel_url FROM payment_intents WHERE id = ?',
    [req.params.id],
  );
  if (!payment) {
    res.status(404).json({ error: 'Checkout session not found' });
    return;
  }
  if (['PENDING', 'DETECTED'].includes(payment.status)) {
    await db.execute("UPDATE payment_intents SET status = 'FAILED', updated_at = ? WHERE id = ?", [
      isoNow(),
      payment.id,
    ]);
    emitPaymentUpdated({
      paymentId: payment.id,
      merchantId: payment.merchant_id,
      status: 'FAILED',
      provider: payment.provider,
      amountBdt: Number(payment.amount_bdt),
    });
  }
  res.json({ paymentId: payment.id, status: 'FAILED', cancelUrl: payment.cancel_url });
});

// Legacy TrxID submit compatibility endpoint (kept so old integrations never break)
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
  const trxId = req.body?.trxId ? String(req.body.trxId).trim().toUpperCase() : null;
  const rawSender = String(req.body?.senderPhone ?? '').trim();
  const senderPhone = rawSender ? normalizeBdPhone(rawSender) : null;

  if (trxId) {
    const usedTrx = await db.queryOne<{ id: string }>(
      `SELECT id FROM provider_verifications
       WHERE provider_trx_id = ? AND decision = 'VERIFIED' LIMIT 1`,
      [trxId],
    );
    if (usedTrx) {
      res.status(409).json({ error: 'This Transaction ID has already been used for a verified settlement.' });
      return;
    }
  }

  const now = isoNow();
  await db.execute(
    `UPDATE payment_intents
     SET provider = ?, submitted_trx_id = COALESCE(?, submitted_trx_id),
         submitted_sender_phone = COALESCE(?, submitted_sender_phone),
         submitted_at = ?, detected_at = COALESCE(detected_at, ?),
         status = CASE WHEN status = 'PENDING' THEN 'DETECTED' ELSE status END, updated_at = ?
     WHERE id = ?`,
    [requestedProvider, trxId, senderPhone, now, now, now, payment.id],
  );

  await reconcilePreArrivedNotificationForIntent(payment.id);
  const refreshed = await db.queryOne<{ status: string }>('SELECT status FROM payment_intents WHERE id = ?', [
    payment.id,
  ]);

  res.json({
    paymentId: payment.id,
    status: refreshed?.status ?? 'DETECTED',
    submittedTrxId: trxId,
    message: 'Payment confirmation submitted.',
  });
});
