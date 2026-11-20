import { env } from '../config/env.ts';
import { getDb, isoNow } from '../db/client.ts';
import { emitPaymentUpdated } from '../realtime/socket.ts';
import { newId } from '../utils/crypto.ts';
import { recordAuditLog } from './auditService.ts';
import { dispatchMerchantWebhook } from './webhookService.ts';

interface PaymentRow {
  id: string;
  merchant_id: string;
  wallet_id: string | null;
  merchant_order_id: string;
  provider: string;
  amount_bdt: number;
  submitted_trx_id: string | null;
  status: string;
  matched_notification_id: string | null;
}

export class VerificationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function verifyPaymentManually(params: {
  paymentId: string;
  verifierUserId: string;
  verifierEmail: string;
  providerTrxId: string;
  verifiedAmountBdt: number;
  documentaryEvidenceRef: string;
  notes: string;
  decision: 'VERIFIED' | 'REJECTED';
  ipAddress?: string | null;
}): Promise<{ paymentId: string; status: string; verificationId: string }> {
  const db = getDb();

  if (!params.documentaryEvidenceRef || params.documentaryEvidenceRef.trim().length < 5) {
    throw new VerificationError(
      'Independent documentary evidence reference (min 5 characters, e.g. merchant portal or bank statement ref) is mandatory.',
      400,
    );
  }
  if (!params.providerTrxId || params.providerTrxId.trim().length < 5) {
    throw new VerificationError('Valid provider TrxID is required.', 400);
  }

  const payment = await db.queryOne<PaymentRow>(
    'SELECT id, merchant_id, wallet_id, merchant_order_id, provider, amount_bdt, submitted_trx_id, status, matched_notification_id FROM payment_intents WHERE id = ?',
    [params.paymentId],
  );

  if (!payment) {
    throw new VerificationError('Payment intent not found.', 404);
  }
  if (payment.status === 'SUCCESS') {
    throw new VerificationError('Payment is already verified and settled (SUCCESS).', 409);
  }

  const normalizedTrx = params.providerTrxId.trim().toUpperCase();

  if (params.decision === 'VERIFIED') {
    const existingTrx = await db.queryOne<{ id: string; payment_intent_id: string }>(
      `SELECT id, payment_intent_id FROM provider_verifications
       WHERE provider = ? AND provider_trx_id = ? AND decision = 'VERIFIED'`,
      [payment.provider, normalizedTrx],
    );
    if (existingTrx) {
      throw new VerificationError(
        `Duplicate TrxID blocked: ${normalizedTrx} has already been verified for payment ${existingTrx.payment_intent_id}.`,
        409,
      );
    }

    if (Math.abs(Number(payment.amount_bdt) - Number(params.verifiedAmountBdt)) > 0.01) {
      throw new VerificationError(
        `Verified amount (${params.verifiedAmountBdt} BDT) must match session amount (${payment.amount_bdt} BDT).`,
        400,
      );
    }
  }

  const verificationId = newId();
  const now = isoNow();
  const nextStatus = params.decision === 'VERIFIED' ? 'SUCCESS' : 'FAILED';

  await db.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO provider_verifications (
        id, payment_intent_id, verification_source, provider, provider_trx_id,
        verified_amount_bdt, documentary_evidence_ref, provider_reference_payload_json,
        verifier_user_id, notes, decision, verified_at
      ) VALUES (?, ?, 'MANUAL_FINANCE_VERIFICATION', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        verificationId,
        payment.id,
        payment.provider,
        normalizedTrx,
        params.verifiedAmountBdt,
        params.documentaryEvidenceRef.trim(),
        JSON.stringify({
          verifiedBy: params.verifierEmail,
          method: 'INDEPENDENT_DOCUMENTED_MANUAL_VERIFICATION',
        }),
        params.verifierUserId,
        params.notes.trim(),
        params.decision,
        now,
      ],
    );

    await tx.execute(
      `UPDATE payment_intents
       SET status = ?, submitted_trx_id = COALESCE(submitted_trx_id, ?),
           verified_at = ?, settled_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        nextStatus,
        normalizedTrx,
        params.decision === 'VERIFIED' ? now : null,
        params.decision === 'VERIFIED' ? now : null,
        now,
        payment.id,
      ],
    );

    if (params.decision === 'VERIFIED') {
      if (payment.wallet_id) {
        await tx.execute(
          'UPDATE mfs_wallets SET daily_received_bdt = daily_received_bdt + ? WHERE id = ?',
          [params.verifiedAmountBdt, payment.wallet_id],
        );
      }
      await tx.execute(
        'UPDATE merchants SET settled_balance_bdt = settled_balance_bdt + ? WHERE id = ?',
        [params.verifiedAmountBdt, payment.merchant_id],
      );
      await tx.execute(
        `UPDATE payment_match_candidates SET status = 'SELECTED'
         WHERE payment_intent_id = ? AND notification_event_id = ?`,
        [payment.id, payment.matched_notification_id ?? ''],
      );
    }
  });

  emitPaymentUpdated({
    paymentId: payment.id,
    merchantId: payment.merchant_id,
    status: nextStatus,
    provider: payment.provider,
    amountBdt: Number(payment.amount_bdt),
  });

  await recordAuditLog({
    actorType: 'USER',
    actorId: params.verifierUserId,
    actorEmail: params.verifierEmail,
    action: params.decision === 'VERIFIED' ? 'PAYMENT_MANUALLY_VERIFIED_SUCCESS' : 'PAYMENT_MANUALLY_FAILED',
    resourceType: 'payment_intent',
    resourceId: payment.id,
    ipAddress: params.ipAddress ?? null,
    beforeState: { status: payment.status },
    afterState: {
      status: nextStatus,
      verificationId,
      verificationSource: 'MANUAL_FINANCE_VERIFICATION',
      documentaryEvidenceRef: params.documentaryEvidenceRef.trim(),
      providerTrxId: normalizedTrx,
    },
  });

  await dispatchMerchantWebhook({
    merchantId: payment.merchant_id,
    paymentIntentId: payment.id,
    eventType: params.decision === 'VERIFIED' ? 'payment.verified_settled' : 'payment.failed',
    payload: {
      paymentId: payment.id,
      merchantOrderId: payment.merchant_order_id,
      status: nextStatus,
      provider: payment.provider,
      amountBdt: payment.amount_bdt,
      trxId: normalizedTrx,
      verificationSource: 'MANUAL_FINANCE_VERIFICATION',
      documentaryEvidenceRef: params.documentaryEvidenceRef.trim(),
      verifiedAt: now,
    },
  });

  return { paymentId: payment.id, status: nextStatus, verificationId };
}

export async function verifyPaymentViaProviderApi(params: {
  paymentId: string;
  actorId: string;
  actorEmail: string;
  providerTrxId: string;
  ipAddress?: string | null;
}): Promise<{ paymentId: string; status: string; verificationId: string }> {
  const db = getDb();
  const payment = await db.queryOne<PaymentRow>(
    'SELECT id, merchant_id, wallet_id, merchant_order_id, provider, amount_bdt, submitted_trx_id, status, matched_notification_id FROM payment_intents WHERE id = ?',
    [params.paymentId],
  );

  if (!payment) {
    throw new VerificationError('Payment intent not found.', 404);
  }
  if (payment.status === 'SUCCESS') {
    throw new VerificationError('Payment is already settled (SUCCESS).', 409);
  }

  const trxId = (params.providerTrxId || payment.submitted_trx_id || '').trim().toUpperCase();
  if (!trxId) {
    throw new VerificationError('Transaction ID is required for provider verification.', 400);
  }

  let providerPayload: Record<string, unknown> | null = null;
  let documentaryRef = '';

  if (payment.provider === 'BKASH') {
    if (!env.providers.bkashAppKey || !env.providers.bkashAppSecret || !env.providers.bkashUsername || !env.providers.bkashPassword) {
      throw new VerificationError(
        'Official bKash Tokenized Checkout API credentials are not configured in .env. Configure them or perform Documented Manual Finance Verification.',
        422,
      );
    }

    const tokenRes = await fetch(`${env.providers.bkashBaseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        username: env.providers.bkashUsername,
        password: env.providers.bkashPassword,
      },
      body: JSON.stringify({
        app_key: env.providers.bkashAppKey,
        app_secret: env.providers.bkashAppSecret,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { id_token?: string; statusMessage?: string };
    if (!tokenRes.ok || !tokenJson.id_token) {
      throw new VerificationError(`bKash token grant failed: ${tokenJson.statusMessage || tokenRes.status}`, 502);
    }

    const searchRes = await fetch(`${env.providers.bkashBaseUrl}/tokenized/checkout/general/searchTransaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: tokenJson.id_token,
        'X-APP-Key': env.providers.bkashAppKey,
      },
      body: JSON.stringify({ trxID: trxId }),
    });
    const searchJson = (await searchRes.json()) as {
      trxID?: string;
      transactionStatus?: string;
      amount?: string;
      statusMessage?: string;
    };

    if (!searchRes.ok || searchJson.transactionStatus !== 'Completed') {
      throw new VerificationError(
        `bKash verification failed: ${searchJson.statusMessage || searchJson.transactionStatus || searchRes.status}`,
        422,
      );
    }
    const apiAmt = Number.parseFloat(searchJson.amount || '0');
    if (Math.abs(apiAmt - Number(payment.amount_bdt)) > 0.01) {
      throw new VerificationError(`bKash API amount (${apiAmt}) mismatch.`, 422);
    }
    providerPayload = searchJson as Record<string, unknown>;
    documentaryRef = `BKASH-API-TRX-${trxId}`;
  } else if (payment.provider === 'NAGAD') {
    if (!env.providers.nagadMerchantId || !env.providers.nagadMerchantPrivateKey) {
      throw new VerificationError(
        'Official Nagad Merchant API credentials are not configured in .env. Configure them or perform Documented Manual Finance Verification.',
        422,
      );
    }
    const verifyRes = await fetch(`${env.providers.nagadBaseUrl}/verify/payment/${encodeURIComponent(trxId)}`);
    const verifyJson = (await verifyRes.json()) as { status?: string; amount?: string };
    if (!verifyRes.ok || verifyJson.status !== 'Success') {
      throw new VerificationError(`Nagad verification failed: ${verifyJson.status || verifyRes.status}`, 422);
    }
    const apiAmt = Number.parseFloat(verifyJson.amount || '0');
    if (Math.abs(apiAmt - Number(payment.amount_bdt)) > 0.01) {
      throw new VerificationError(`Nagad API amount (${apiAmt}) mismatch.`, 422);
    }
    providerPayload = verifyJson as Record<string, unknown>;
    documentaryRef = `NAGAD-API-TRX-${trxId}`;
  } else if (payment.provider === 'ROCKET') {
    if (!env.providers.rocketBaseUrl || !env.providers.rocketMerchantId || !env.providers.rocketApiSecret) {
      throw new VerificationError(
        'Official DBBL Rocket Merchant API credentials are not configured in .env. Configure them or perform Documented Manual Finance Verification.',
        422,
      );
    }
    const verifyRes = await fetch(`${env.providers.rocketBaseUrl}/verify/${encodeURIComponent(trxId)}`, {
      headers: {
        'X-Merchant-Id': env.providers.rocketMerchantId,
        Authorization: `Bearer ${env.providers.rocketApiSecret}`,
      },
    });
    const verifyJson = (await verifyRes.json()) as { status?: string };
    if (!verifyRes.ok || verifyJson.status !== 'SUCCESS') {
      throw new VerificationError(`Rocket verification failed: ${verifyJson.status || verifyRes.status}`, 422);
    }
    providerPayload = verifyJson as Record<string, unknown>;
    documentaryRef = `ROCKET-API-TRX-${trxId}`;
  } else {
    throw new VerificationError(
      `${payment.provider} requires Documented Manual Finance Verification (bank/merchant portal reference) as official real-time merchant query API is not available.`,
      422,
    );
  }

  const verificationId = newId();
  const now = isoNow();

  await db.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO provider_verifications (
        id, payment_intent_id, verification_source, provider, provider_trx_id,
        verified_amount_bdt, documentary_evidence_ref, provider_reference_payload_json,
        verifier_user_id, notes, decision, verified_at
      ) VALUES (?, ?, 'PROVIDER_API', ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?)`,
      [
        verificationId,
        payment.id,
        payment.provider,
        trxId,
        payment.amount_bdt,
        documentaryRef,
        JSON.stringify(providerPayload),
        params.actorId,
        'Verified directly via official provider query API.',
        now,
      ],
    );

    await tx.execute(
      `UPDATE payment_intents
       SET status = 'SUCCESS', verified_at = ?, settled_at = ?, updated_at = ?
       WHERE id = ?`,
      [now, now, now, payment.id],
    );

    if (payment.wallet_id) {
      await tx.execute(
        'UPDATE mfs_wallets SET daily_received_bdt = daily_received_bdt + ? WHERE id = ?',
        [payment.amount_bdt, payment.wallet_id],
      );
    }
    await tx.execute(
      'UPDATE merchants SET settled_balance_bdt = settled_balance_bdt + ? WHERE id = ?',
      [payment.amount_bdt, payment.merchant_id],
    );
  });

  emitPaymentUpdated({
    paymentId: payment.id,
    merchantId: payment.merchant_id,
    status: 'SUCCESS',
    provider: payment.provider,
    amountBdt: Number(payment.amount_bdt),
  });

  await recordAuditLog({
    actorType: 'USER',
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    action: 'PAYMENT_PROVIDER_API_VERIFIED_SUCCESS',
    resourceType: 'payment_intent',
    resourceId: payment.id,
    ipAddress: params.ipAddress ?? null,
    beforeState: { status: payment.status },
    afterState: { status: 'SUCCESS', verificationId, documentaryRef, trxId },
  });

  await dispatchMerchantWebhook({
    merchantId: payment.merchant_id,
    paymentIntentId: payment.id,
    eventType: 'payment.verified_settled',
    payload: {
      paymentId: payment.id,
      merchantOrderId: payment.merchant_order_id,
      status: 'SUCCESS',
      provider: payment.provider,
      amountBdt: payment.amount_bdt,
      trxId,
      verificationSource: 'PROVIDER_API',
      documentaryEvidenceRef: documentaryRef,
      verifiedAt: now,
    },
  });

  return { paymentId: payment.id, status: 'SUCCESS', verificationId };
}

export async function autoVerifyWithDeterministicProof(params: {
  paymentId: string;
  deviceId: string;
  notificationEventId: string;
  providerTrxId: string;
  verifiedAmountBdt: number;
  confidenceScore: number;
  reasons: string[];
  ipAddress?: string | null;
}): Promise<{ verified: boolean; status: string; verificationId?: string; reason?: string }> {
  const db = getDb();
  const payment = await db.queryOne<
    PaymentRow & { mode: string; account_mode: string; unique_paisa_offset: number }
  >(
    `SELECT id, merchant_id, wallet_id, merchant_order_id, provider, mode, account_mode,
            amount_bdt, unique_paisa_offset, submitted_trx_id, status, matched_notification_id
     FROM payment_intents WHERE id = ?`,
    [params.paymentId],
  );

  if (!payment) {
    return { verified: false, status: 'NOT_FOUND', reason: 'Payment intent not found' };
  }
  if (payment.status === 'SUCCESS') {
    return { verified: true, status: 'SUCCESS', reason: 'Already settled' };
  }

  const normalizedTrx = params.providerTrxId.trim().toUpperCase();
  if (normalizedTrx.length < 6) {
    return { verified: false, status: payment.status, reason: 'Invalid TrxID length for deterministic proof' };
  }
  if (Math.abs(Number(payment.amount_bdt) - Number(params.verifiedAmountBdt)) >= 0.005) {
    return { verified: false, status: payment.status, reason: 'Exact amount mismatch' };
  }

  // Atomic check: TrxID must never have been verified previously
  const existingTrx = await db.queryOne<{ id: string }>(
    `SELECT id FROM provider_verifications
     WHERE provider = ? AND provider_trx_id = ? AND decision = 'VERIFIED' LIMIT 1`,
    [payment.provider, normalizedTrx],
  );
  if (existingTrx) {
    return { verified: false, status: payment.status, reason: 'TrxID already verified on another order' };
  }

  const verificationId = newId();
  const now = isoNow();
  const verificationMethod =
    Number(payment.unique_paisa_offset || 0) > 0
      ? 'ZERO_TRXID_MICRO_AMOUNT_HMAC_PROOF'
      : 'ZERO_TRXID_DETERMINISTIC_PROOF';
  const documentaryRef = `AUTO-${params.deviceId.slice(0, 8).toUpperCase()}-${normalizedTrx}`;

  await db.withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO provider_verifications (
        id, payment_intent_id, verification_source, provider, provider_trx_id,
        verified_amount_bdt, documentary_evidence_ref, provider_reference_payload_json,
        verifier_user_id, notes, decision, verified_at
      ) VALUES (?, ?, 'DETERMINISTIC_PERSONAL_PROOF', ?, ?, ?, ?, ?, NULL, ?, 'VERIFIED', ?)`,
      [
        verificationId,
        payment.id,
        payment.provider,
        normalizedTrx,
        params.verifiedAmountBdt,
        documentaryRef,
        JSON.stringify({
          deviceId: params.deviceId,
          notificationEventId: params.notificationEventId,
          confidenceScore: params.confidenceScore,
          proofFactors: params.reasons,
          verificationMethod,
        }),
        `Automated Zero-TrxID deterministic verification (${params.reasons.join(', ')})`,
        now,
      ],
    );

    await tx.execute(
      `UPDATE payment_intents
       SET status = 'SUCCESS', submitted_trx_id = COALESCE(submitted_trx_id, ?),
           verification_method = ?, auto_verified = 1,
           verified_at = ?, settled_at = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedTrx, verificationMethod, now, now, now, payment.id],
    );

    if (payment.mode !== 'TEST') {
      if (payment.wallet_id) {
        await tx.execute(
          'UPDATE mfs_wallets SET daily_received_bdt = daily_received_bdt + ? WHERE id = ?',
          [params.verifiedAmountBdt, payment.wallet_id],
        );
      }
      await tx.execute(
        'UPDATE merchants SET settled_balance_bdt = settled_balance_bdt + ? WHERE id = ?',
        [params.verifiedAmountBdt, payment.merchant_id],
      );
    }

    await tx.execute(
      `UPDATE payment_match_candidates SET status = 'SELECTED'
       WHERE payment_intent_id = ? AND notification_event_id = ?`,
      [payment.id, params.notificationEventId],
    );
  });

  emitPaymentUpdated({
    paymentId: payment.id,
    merchantId: payment.merchant_id,
    status: 'SUCCESS',
    provider: payment.provider,
    amountBdt: Number(payment.amount_bdt),
    matchConfidence: params.confidenceScore,
  });

  await recordAuditLog({
    actorType: 'DEVICE',
    actorId: params.deviceId,
    action: 'PAYMENT_ZERO_TRXID_AUTO_VERIFIED_SUCCESS',
    resourceType: 'payment_intent',
    resourceId: payment.id,
    ipAddress: params.ipAddress ?? null,
    beforeState: { status: payment.status },
    afterState: {
      status: 'SUCCESS',
      verificationId,
      verificationSource: 'DETERMINISTIC_PERSONAL_PROOF',
      verificationMethod,
      documentaryRef,
      providerTrxId: normalizedTrx,
      proofFactors: params.reasons,
    },
  });

  await dispatchMerchantWebhook({
    merchantId: payment.merchant_id,
    paymentIntentId: payment.id,
    eventType: 'payment.verified_settled',
    payload: {
      paymentId: payment.id,
      merchantOrderId: payment.merchant_order_id,
      mode: payment.mode,
      status: 'SUCCESS',
      provider: payment.provider,
      amountBdt: payment.amount_bdt,
      trxId: normalizedTrx,
      verificationSource: 'DETERMINISTIC_PERSONAL_PROOF',
      verificationMethod,
      documentaryEvidenceRef: documentaryRef,
      verifiedAt: now,
    },
  });

  return { verified: true, status: 'SUCCESS', verificationId };
}

