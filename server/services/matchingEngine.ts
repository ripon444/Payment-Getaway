import { getDb, isoNow } from '../db/client.ts';
import { parseMfsNotification, registerDynamicBankTemplates } from '../parsers/index.ts';
import type { DynamicBankTemplate } from '../parsers/bankSmsParser.ts';
import type { RawNotificationInput } from '../parsers/index.ts';
import { emitFraudAlert, emitNotificationIngested, emitPaymentUpdated } from '../realtime/socket.ts';
import { newId, sha256Hex } from '../utils/crypto.ts';
import { recordAuditLog } from './auditService.ts';
import { dispatchMerchantWebhook } from './webhookService.ts';

export interface IngestNotificationRequest extends RawNotificationInput {
  deviceId: string;
  merchantId: string | null;
  eventUid: string;
  deviceTimestampMs: number;
  ipAddress?: string | null;
}

export interface IngestResult {
  eventId: string;
  parseStatus: string;
  provider: string;
  parserModule: string;
  parsedAmountBdt: number | null;
  parsedTrxId: string | null;
  parsedBankName: string | null;
  parsedTransactionTime: string | null;
  duplicate: boolean;
  duplicateReason?: string;
  candidatePaymentId: string | null;
  paymentStatusAfter: string | null;
  confidenceScore: number | null;
  note: string;
}

interface OpenIntentRow {
  id: string;
  merchant_id: string;
  wallet_id: string | null;
  wallet_number: string | null;
  merchant_order_id: string;
  provider: string;
  amount_bdt: number;
  customer_phone: string | null;
  reference_code: string;
  submitted_trx_id: string | null;
  submitted_sender_phone: string | null;
  status: string;
  expires_at: string;
  created_at: string;
}

async function createFraudAlert(params: {
  merchantId: string | null;
  paymentIntentId: string | null;
  deviceId: string | null;
  alertType: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  details: Record<string, unknown>;
}) {
  const db = getDb();
  const id = newId();
  await db.execute(
    `INSERT INTO fraud_alerts (id, merchant_id, payment_intent_id, device_id, alert_type, severity, summary, details_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
    [
      id,
      params.merchantId,
      params.paymentIntentId,
      params.deviceId,
      params.alertType,
      params.severity,
      params.summary,
      JSON.stringify(params.details),
      isoNow(),
    ],
  );
  emitFraudAlert({
    id,
    merchantId: params.merchantId,
    alertType: params.alertType,
    severity: params.severity,
    summary: params.summary,
  });
}

export async function ingestDeviceNotification(req: IngestNotificationRequest): Promise<IngestResult> {
  const db = getDb();
  const now = isoNow();

  // Refresh dynamic bank SMS regex templates before parsing
  const tplRows = await db.query<DynamicBankTemplate>(
    'SELECT bank_name, sender_id, amount_regex, trx_regex, account_regex FROM bank_sms_templates WHERE is_active = 1',
  );
  registerDynamicBankTemplates(tplRows);

  const parsed = parseMfsNotification(req);

  const canonicalKey =
    parsed.trxId && parsed.amountBdt !== null
      ? `${parsed.provider}|${parsed.trxId}|${parsed.amountBdt.toFixed(2)}`
      : `${req.deviceId}|${req.eventUid}|${parsed.redactedBody}`;
  const eventHash = sha256Hex(canonicalKey);

  // 1. Check exact eventHash duplicate
  const existingHash = await db.queryOne<{ id: string; candidate_payment_id: string | null }>(
    'SELECT id, candidate_payment_id FROM notification_events WHERE event_hash = ?',
    [eventHash],
  );

  if (existingHash) {
    const dupId = newId();
    await db.execute(
      `INSERT INTO notification_events (
        id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header,
        provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt,
        parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt,
        parsed_tx_type, parsed_bank_name, parsed_transaction_time, parser_module, parser_confidence, parse_status,
        duplicate_of_event_id, candidate_payment_id, device_timestamp_ms, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DUPLICATE', ?, ?, ?, ?)`,
      [
        dupId,
        req.deviceId,
        req.merchantId,
        req.sourceChannel ?? 'NOTIFICATION',
        req.simSlot ?? null,
        req.packageName,
        req.senderHeader ?? null,
        parsed.provider,
        req.eventUid,
        sha256Hex(`${eventHash}|dup|${dupId}`),
        req.title ?? null,
        parsed.redactedBody,
        parsed.amountBdt,
        parsed.trxId,
        parsed.senderPhone,
        parsed.receiverAccount,
        parsed.balanceBdt,
        parsed.txType,
        parsed.bankName,
        parsed.transactionTime,
        parsed.parserModule,
        parsed.confidence,
        existingHash.id,
        existingHash.candidate_payment_id,
        req.deviceTimestampMs,
        now,
      ],
    );

    if (parsed.trxId) {
      await createFraudAlert({
        merchantId: req.merchantId,
        paymentIntentId: existingHash.candidate_payment_id,
        deviceId: req.deviceId,
        alertType: 'DUPLICATE_NOTIFICATION_REPLAY',
        severity: 'MEDIUM',
        summary: `Duplicate ${parsed.provider} TrxID ${parsed.trxId} alert replay blocked`,
        details: { duplicateOf: existingHash.id, provider: parsed.provider, trxId: parsed.trxId },
      });
    }

    await recordAuditLog({
      actorType: 'DEVICE',
      actorId: req.deviceId,
      action: 'DUPLICATE_NOTIFICATION_DETECTED',
      resourceType: 'notification_event',
      resourceId: dupId,
      ipAddress: req.ipAddress ?? null,
      afterState: { duplicateOf: existingHash.id, trxId: parsed.trxId, provider: parsed.provider },
    });

    emitNotificationIngested({
      eventId: dupId,
      merchantId: req.merchantId,
      provider: parsed.provider,
      parseStatus: 'DUPLICATE',
      parsedTrxId: parsed.trxId,
      parsedAmountBdt: parsed.amountBdt,
    });

    return {
      eventId: dupId,
      parseStatus: 'DUPLICATE',
      provider: parsed.provider,
      parserModule: parsed.parserModule,
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      parsedBankName: parsed.bankName,
      parsedTransactionTime: parsed.transactionTime,
      duplicate: true,
      duplicateReason: 'Exact notification hash already recorded',
      candidatePaymentId: existingHash.candidate_payment_id,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: 'Duplicate notification blocked to prevent double-crediting.',
    };
  }

  // 2. Check TrxID reuse against previously parsed or settled transactions
  let trxDuplicateEvent: { id: string } | null = null;
  let alreadySettledTrx: { id: string; payment_intent_id: string } | null = null;

  if (parsed.trxId && parsed.provider !== 'UNKNOWN') {
    trxDuplicateEvent = await db.queryOne<{ id: string }>(
      `SELECT id FROM notification_events
       WHERE provider = ? AND parsed_trx_id = ? AND parse_status = 'PARSED'
       LIMIT 1`,
      [parsed.provider, parsed.trxId],
    );
    alreadySettledTrx = await db.queryOne<{ id: string; payment_intent_id: string }>(
      `SELECT id, payment_intent_id FROM provider_verifications
       WHERE provider = ? AND provider_trx_id = ? AND decision = 'VERIFIED'
       LIMIT 1`,
      [parsed.provider, parsed.trxId],
    );
  }

  const eventId = newId();
  const isDupTrx = Boolean(trxDuplicateEvent || alreadySettledTrx);
  const finalParseStatus = isDupTrx ? 'DUPLICATE' : parsed.parseStatus;

  await db.execute(
    `INSERT INTO notification_events (
      id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header,
      provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt,
      parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt,
      parsed_tx_type, parsed_bank_name, parsed_transaction_time, parser_module, parser_confidence, parse_status,
      duplicate_of_event_id, device_timestamp_ms, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      req.deviceId,
      req.merchantId,
      req.sourceChannel ?? 'NOTIFICATION',
      req.simSlot ?? null,
      req.packageName,
      req.senderHeader ?? null,
      parsed.provider,
      req.eventUid,
      eventHash,
      req.title ?? null,
      parsed.redactedBody,
      parsed.amountBdt,
      parsed.trxId,
      parsed.senderPhone,
      parsed.receiverAccount,
      parsed.balanceBdt,
      parsed.txType,
      parsed.bankName,
      parsed.transactionTime,
      parsed.parserModule,
      parsed.confidence,
      finalParseStatus,
      trxDuplicateEvent?.id ?? null,
      req.deviceTimestampMs,
      now,
    ],
  );

  emitNotificationIngested({
    eventId,
    merchantId: req.merchantId,
    provider: parsed.provider,
    parseStatus: finalParseStatus,
    parsedTrxId: parsed.trxId,
    parsedAmountBdt: parsed.amountBdt,
  });

  if (isDupTrx) {
    await createFraudAlert({
      merchantId: req.merchantId,
      paymentIntentId: alreadySettledTrx?.payment_intent_id ?? null,
      deviceId: req.deviceId,
      alertType: 'DUPLICATE_TRX_REUSE',
      severity: 'HIGH',
      summary: `Duplicate ${parsed.provider} TrxID ${parsed.trxId} intercepted and blocked`,
      details: {
        provider: parsed.provider,
        trxId: parsed.trxId,
        amountBdt: parsed.amountBdt,
        alreadySettled: Boolean(alreadySettledTrx),
      },
    });

    await recordAuditLog({
      actorType: 'DEVICE',
      actorId: req.deviceId,
      action: 'DUPLICATE_TRX_ID_BLOCKED',
      resourceType: 'notification_event',
      resourceId: eventId,
      ipAddress: req.ipAddress ?? null,
      afterState: {
        provider: parsed.provider,
        trxId: parsed.trxId,
        alreadySettled: Boolean(alreadySettledTrx),
      },
    });

    return {
      eventId,
      parseStatus: 'DUPLICATE',
      provider: parsed.provider,
      parserModule: parsed.parserModule,
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      parsedBankName: parsed.bankName,
      parsedTransactionTime: parsed.transactionTime,
      duplicate: true,
      duplicateReason: alreadySettledTrx
        ? 'TrxID already verified & settled previously'
        : 'TrxID already received from another notification',
      candidatePaymentId: null,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: 'Duplicate TrxID flagged. Payment will NOT be matched.',
    };
  }

  if (finalParseStatus !== 'PARSED' || parsed.provider === 'UNKNOWN' || parsed.amountBdt === null) {
    return {
      eventId,
      parseStatus: finalParseStatus,
      provider: parsed.provider,
      parserModule: parsed.parserModule,
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      parsedBankName: parsed.bankName,
      parsedTransactionTime: parsed.transactionTime,
      duplicate: false,
      candidatePaymentId: null,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: parsed.warnings.join('; ') || 'Notification stored without candidate match.',
    };
  }

  // 3. Multi-factor matching across open sessions
  const assignedWallets = await db.query<{ wallet_id: string }>(
    'SELECT wallet_id FROM device_wallets WHERE device_id = ?',
    [req.deviceId],
  );
  const walletIds = new Set(assignedWallets.map((w) => w.wallet_id));

  // Cross-compatibility: a BANGLA_QR or BANK_SMS or CELLFIN credit may satisfy a BANGLA_QR payment session
  const candidateProviders =
    parsed.provider === 'BANK_SMS' || parsed.provider === 'CELLFIN'
      ? [parsed.provider, 'BANGLA_QR']
      : [parsed.provider];

  const placeholders = candidateProviders.map(() => '?').join(', ');
  const openIntents = await db.query<OpenIntentRow>(
    `SELECT p.id, p.merchant_id, p.wallet_id, w.account_number AS wallet_number,
            p.merchant_order_id, p.provider, p.amount_bdt,
            p.customer_phone, p.reference_code, p.submitted_trx_id,
            p.submitted_sender_phone, p.status, p.expires_at, p.created_at
     FROM payment_intents p
     LEFT JOIN mfs_wallets w ON w.id = p.wallet_id
     WHERE p.provider IN (${placeholders})
       AND p.status IN ('PENDING', 'DETECTED', 'REVIEW_REQUIRED')
       ${req.merchantId ? 'AND p.merchant_id = ?' : ''}
     ORDER BY p.created_at DESC
     LIMIT 120`,
    req.merchantId ? [...candidateProviders, req.merchantId] : candidateProviders,
  );

  const scoredCandidates: Array<{ intent: OpenIntentRow; score: number; reasons: string[] }> = [];

  for (const intent of openIntents) {
    let score = 0;
    const reasons: string[] = [];

    // Check expiry window
    const expTime = new Date(intent.expires_at.replace(' ', 'T') + 'Z').getTime();
    if (Number.isFinite(expTime) && req.deviceTimestampMs > expTime + 10 * 60_000) {
      continue;
    }

    // Provider match
    if (intent.provider === parsed.provider) {
      score += 20;
      reasons.push('PROVIDER_EXACT');
    } else if (intent.provider === 'BANGLA_QR') {
      score += 15;
      reasons.push('BANGLA_QR_CROSS_BANK_MATCH');
    }

    // Device-to-Wallet assignment match
    if (intent.wallet_id && walletIds.has(intent.wallet_id)) {
      score += 10;
      reasons.push('DEVICE_WALLET_ASSIGNED');
    }

    // Receiver account suffix match (for masked bank accounts like ***8841)
    if (parsed.receiverAccount && intent.wallet_number) {
      const parsedDigits = parsed.receiverAccount.replace(/[^\d]/g, '');
      const walletDigits = intent.wallet_number.replace(/[^\d]/g, '');
      if (parsedDigits.length >= 4 && walletDigits.endsWith(parsedDigits.slice(-4))) {
        score += 15;
        reasons.push('RECEIVER_ACCOUNT_SUFFIX_MATCH');
      }
    }

    // Customer-submitted TrxID match
    if (intent.submitted_trx_id && parsed.trxId) {
      if (intent.submitted_trx_id.toUpperCase() === parsed.trxId.toUpperCase()) {
        score += 35;
        reasons.push('TRX_ID_EXACT');
      } else {
        continue;
      }
    }

    // Amount check
    const diff = Math.abs(Number(intent.amount_bdt) - parsed.amountBdt);
    if (diff < 0.01) {
      score += 30;
      reasons.push('AMOUNT_EXACT');
    } else if (diff <= 50 && intent.submitted_trx_id?.toUpperCase() === parsed.trxId?.toUpperCase()) {
      score -= 10;
      reasons.push(`AMOUNT_MISMATCH_DIFF_${diff.toFixed(2)}`);
    } else {
      continue;
    }

    // Sender phone match
    const expectedPhone = intent.submitted_sender_phone || intent.customer_phone;
    if (expectedPhone && parsed.senderPhone && expectedPhone.slice(-8) === parsed.senderPhone.slice(-8)) {
      score += 10;
      reasons.push('SENDER_PHONE_MATCH');
    }

    // Reference code match
    if (parsed.reference && intent.reference_code.toUpperCase() === parsed.reference.toUpperCase()) {
      score += 10;
      reasons.push('REFERENCE_MATCH');
    }

    if (score >= 45) {
      scoredCandidates.push({ intent, score: Math.min(100, score), reasons });
    }
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  if (scoredCandidates.length === 0) {
    return {
      eventId,
      parseStatus: 'PARSED',
      provider: parsed.provider,
      parserModule: parsed.parserModule,
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      parsedBankName: parsed.bankName,
      parsedTransactionTime: parsed.transactionTime,
      duplicate: false,
      candidatePaymentId: null,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: 'Parsed alert stored; no open matching payment session found.',
    };
  }

  for (const cand of scoredCandidates.slice(0, 3)) {
    await db.execute(
      `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?)`,
      [newId(), cand.intent.id, eventId, cand.score, JSON.stringify(cand.reasons), now],
    );
  }

  const top = scoredCandidates[0];
  const hasAmbiguousTie =
    scoredCandidates.length > 1 && scoredCandidates[1].score >= top.score - 10;
  const hasAmountMismatch = top.reasons.some((r) => r.startsWith('AMOUNT_MISMATCH'));

  if (hasAmountMismatch) {
    await createFraudAlert({
      merchantId: top.intent.merchant_id,
      paymentIntentId: top.intent.id,
      deviceId: req.deviceId,
      alertType: 'AMOUNT_MISMATCH',
      severity: 'MEDIUM',
      summary: `Amount mismatch on ${top.intent.merchant_order_id}: expected ৳${top.intent.amount_bdt}, received ৳${parsed.amountBdt}`,
      details: { expectedBdt: top.intent.amount_bdt, receivedBdt: parsed.amountBdt, trxId: parsed.trxId },
    });
  }

  // COMPLIANCE INVARIANT: Never set VERIFIED or SUCCESS from notification/SMS alone.
  const nextStatus =
    !hasAmbiguousTie && !hasAmountMismatch && top.score >= 70
      ? 'MATCHED'
      : 'REVIEW_REQUIRED';

  await db.execute(
    `UPDATE payment_intents
     SET status = ?, match_confidence = ?, matched_notification_id = ?,
         detected_at = COALESCE(detected_at, ?), matched_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('PENDING', 'DETECTED', 'REVIEW_REQUIRED')`,
    [nextStatus, top.score, eventId, now, now, now, top.intent.id],
  );

  await db.execute('UPDATE notification_events SET candidate_payment_id = ? WHERE id = ?', [
    top.intent.id,
    eventId,
  ]);

  emitPaymentUpdated({
    paymentId: top.intent.id,
    merchantId: top.intent.merchant_id,
    status: nextStatus,
    provider: top.intent.provider,
    amountBdt: Number(top.intent.amount_bdt),
    matchConfidence: top.score,
  });

  await recordAuditLog({
    actorType: 'DEVICE',
    actorId: req.deviceId,
    action: nextStatus === 'MATCHED' ? 'NOTIFICATION_MATCHED' : 'NOTIFICATION_FLAGGED_REVIEW_REQUIRED',
    resourceType: 'payment_intent',
    resourceId: top.intent.id,
    ipAddress: req.ipAddress ?? null,
    beforeState: { status: top.intent.status },
    afterState: {
      status: nextStatus,
      confidenceScore: top.score,
      reasons: top.reasons,
      notificationEventId: eventId,
      complianceNote: 'Notification match does not settle order; authorized verification required for SUCCESS.',
    },
  });

  await dispatchMerchantWebhook({
    merchantId: top.intent.merchant_id,
    paymentIntentId: top.intent.id,
    eventType:
      nextStatus === 'MATCHED'
        ? 'payment.matched'
        : 'payment.review_required',
    payload: {
      paymentId: top.intent.id,
      merchantOrderId: top.intent.merchant_order_id,
      status: nextStatus,
      provider: top.intent.provider,
      amountBdt: top.intent.amount_bdt,
      candidateTrxId: parsed.trxId,
      confidenceScore: top.score,
      requiresVerification: true,
    },
  });

  return {
    eventId,
    parseStatus: 'PARSED',
    provider: parsed.provider,
    parserModule: parsed.parserModule,
    parsedAmountBdt: parsed.amountBdt,
    parsedTrxId: parsed.trxId,
    parsedBankName: parsed.bankName,
    parsedTransactionTime: parsed.transactionTime,
    duplicate: false,
    candidatePaymentId: top.intent.id,
    paymentStatusAfter: nextStatus,
    confidenceScore: top.score,
    note:
      nextStatus === 'MATCHED'
        ? 'Notification matched to payment session (MATCHED). Awaiting authorized provider or finance verification for SUCCESS.'
        : 'Ambiguous or mismatched alert routed to REVIEW_REQUIRED.',
  };
}
