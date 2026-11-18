import { getDb, isoNow } from '../db/client.ts';
import { parseMfsNotification } from '../parsers/index.ts';
import type { RawNotificationInput } from '../parsers/index.ts';
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
  parsedAmountBdt: number | null;
  parsedTrxId: string | null;
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
  merchant_order_id: string;
  provider: string;
  amount_bdt: number;
  customer_phone: string | null;
  reference_code: string;
  submitted_trx_id: string | null;
  submitted_sender_phone: string | null;
  status: string;
  expires_at: string;
}

export async function ingestDeviceNotification(req: IngestNotificationRequest): Promise<IngestResult> {
  const db = getDb();
  const now = isoNow();
  const parsed = parseMfsNotification(req);

  const canonicalKey = parsed.trxId && parsed.amountBdt !== null
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
        id, device_id, merchant_id, package_name, provider, event_uid, event_hash,
        raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone,
        parsed_balance_bdt, parsed_tx_type, parser_confidence, parse_status,
        duplicate_of_event_id, candidate_payment_id, device_timestamp_ms, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DUPLICATE', ?, ?, ?, ?)`,
      [
        dupId,
        req.deviceId,
        req.merchantId,
        req.packageName,
        parsed.provider,
        req.eventUid,
        sha256Hex(`${eventHash}|dup|${dupId}`),
        req.title ?? null,
        parsed.redactedBody,
        parsed.amountBdt,
        parsed.trxId,
        parsed.senderPhone,
        parsed.balanceBdt,
        parsed.txType,
        parsed.confidence,
        existingHash.id,
        existingHash.candidate_payment_id,
        req.deviceTimestampMs,
        now,
      ],
    );

    await recordAuditLog({
      actorType: 'DEVICE',
      actorId: req.deviceId,
      action: 'DUPLICATE_NOTIFICATION_DETECTED',
      resourceType: 'notification_event',
      resourceId: dupId,
      ipAddress: req.ipAddress ?? null,
      afterState: { duplicateOf: existingHash.id, trxId: parsed.trxId, provider: parsed.provider },
    });

    return {
      eventId: dupId,
      parseStatus: 'DUPLICATE',
      provider: parsed.provider,
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      duplicate: true,
      duplicateReason: 'Exact notification hash already recorded',
      candidatePaymentId: existingHash.candidate_payment_id,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: 'Duplicate notification ignored to prevent double-crediting.',
    };
  }

  // 2. Check TrxID reuse against already-settled or previously parsed TrxID
  let trxDuplicateEvent: { id: string } | null = null;
  let alreadySettledTrx: { id: string } | null = null;
  if (parsed.trxId && parsed.provider !== 'UNKNOWN') {
    trxDuplicateEvent = await db.queryOne<{ id: string }>(
      `SELECT id FROM notification_events
       WHERE provider = ? AND parsed_trx_id = ? AND parse_status = 'PARSED'
       LIMIT 1`,
      [parsed.provider, parsed.trxId],
    );
    alreadySettledTrx = await db.queryOne<{ id: string }>(
      `SELECT id FROM provider_verifications
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
      id, device_id, merchant_id, package_name, provider, event_uid, event_hash,
      raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone,
      parsed_balance_bdt, parsed_tx_type, parser_confidence, parse_status,
      duplicate_of_event_id, device_timestamp_ms, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      req.deviceId,
      req.merchantId,
      req.packageName,
      parsed.provider,
      req.eventUid,
      eventHash,
      req.title ?? null,
      parsed.redactedBody,
      parsed.amountBdt,
      parsed.trxId,
      parsed.senderPhone,
      parsed.balanceBdt,
      parsed.txType,
      parsed.confidence,
      finalParseStatus,
      trxDuplicateEvent?.id ?? null,
      req.deviceTimestampMs,
      now,
    ],
  );

  if (isDupTrx) {
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
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
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
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      duplicate: false,
      candidatePaymentId: null,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: parsed.warnings.join('; ') || 'Notification stored without candidate match.',
    };
  }

  // 3. Find assigned wallets for this device to scope multi-merchant matching safely
  const assignedWallets = await db.query<{ wallet_id: string }>(
    'SELECT wallet_id FROM device_wallets WHERE device_id = ?',
    [req.deviceId],
  );
  const walletIds = new Set(assignedWallets.map((w) => w.wallet_id));

  // Query open payment intents for the provider (optionally scoped to merchant)
  const openIntents = await db.query<OpenIntentRow>(
    `SELECT id, merchant_id, wallet_id, merchant_order_id, provider, amount_bdt,
            customer_phone, reference_code, submitted_trx_id, submitted_sender_phone, status, expires_at
     FROM payment_intents
     WHERE provider = ?
       AND status IN ('CREATED', 'CUSTOMER_SUBMITTED', 'MANUAL_REVIEW_REQUIRED')
       ${req.merchantId ? 'AND merchant_id = ?' : ''}
     ORDER BY created_at DESC
     LIMIT 100`,
    req.merchantId ? [parsed.provider, req.merchantId] : [parsed.provider],
  );

  const scoredCandidates: Array<{ intent: OpenIntentRow; score: number; reasons: string[] }> = [];

  for (const intent of openIntents) {
    let score = 0;
    const reasons: string[] = [];

    // Provider match
    if (intent.provider === parsed.provider) {
      score += 20;
      reasons.push('PROVIDER_EXACT');
    }

    // Wallet routing match
    if (intent.wallet_id && walletIds.has(intent.wallet_id)) {
      score += 10;
      reasons.push('DEVICE_WALLET_ASSIGNED');
    }

    // TrxID submitted by customer matches notification TrxID
    if (intent.submitted_trx_id && parsed.trxId) {
      if (intent.submitted_trx_id.toUpperCase() === parsed.trxId.toUpperCase()) {
        score += 35;
        reasons.push('TRX_ID_EXACT');
      } else {
        // Explicit TrxID conflict -> skip matching unless same phone & amount
        continue;
      }
    }

    // Amount comparison
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

    // Phone matching
    const expectedPhone = intent.submitted_sender_phone || intent.customer_phone;
    if (expectedPhone && parsed.senderPhone) {
      if (expectedPhone.slice(-8) === parsed.senderPhone.slice(-8)) {
        score += 10;
        reasons.push('SENDER_PHONE_MATCH');
      }
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
      parsedAmountBdt: parsed.amountBdt,
      parsedTrxId: parsed.trxId,
      duplicate: false,
      candidatePaymentId: null,
      paymentStatusAfter: null,
      confidenceScore: null,
      note: 'Parsed notification stored; no matching open payment intent found.',
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

  // CRITICAL COMPLIANCE INVARIANT:
  // A notification NEVER settles a payment. It only marks CANDIDATE_MATCHED or MANUAL_REVIEW_REQUIRED.
  const nextStatus =
    !hasAmbiguousTie && !hasAmountMismatch && top.score >= 70
      ? 'CANDIDATE_MATCHED'
      : 'MANUAL_REVIEW_REQUIRED';

  await db.execute(
    `UPDATE payment_intents
     SET status = ?, match_confidence = ?, matched_notification_id = ?, updated_at = ?
     WHERE id = ? AND status IN ('CREATED', 'CUSTOMER_SUBMITTED', 'MANUAL_REVIEW_REQUIRED')`,
    [nextStatus, top.score, eventId, now, top.intent.id],
  );

  await db.execute(
    'UPDATE notification_events SET candidate_payment_id = ? WHERE id = ?',
    [top.intent.id, eventId],
  );

  await recordAuditLog({
    actorType: 'DEVICE',
    actorId: req.deviceId,
    action: nextStatus === 'CANDIDATE_MATCHED'
      ? 'NOTIFICATION_CANDIDATE_MATCHED'
      : 'NOTIFICATION_FLAGGED_MANUAL_REVIEW',
    resourceType: 'payment_intent',
    resourceId: top.intent.id,
    ipAddress: req.ipAddress ?? null,
    beforeState: { status: top.intent.status },
    afterState: {
      status: nextStatus,
      confidenceScore: top.score,
      reasons: top.reasons,
      notificationEventId: eventId,
      settlementNote: 'Notification alone does not settle payment; provider API or documented manual verification required.',
    },
  });

  await dispatchMerchantWebhook({
    merchantId: top.intent.merchant_id,
    paymentIntentId: top.intent.id,
    eventType:
      nextStatus === 'CANDIDATE_MATCHED'
        ? 'payment.candidate_matched'
        : 'payment.manual_review_required',
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
    parsedAmountBdt: parsed.amountBdt,
    parsedTrxId: parsed.trxId,
    duplicate: false,
    candidatePaymentId: top.intent.id,
    paymentStatusAfter: nextStatus,
    confidenceScore: top.score,
    note:
      nextStatus === 'CANDIDATE_MATCHED'
        ? 'Candidate match recorded. Awaiting authorized provider API or documented manual verification.'
        : 'Ambiguous or mismatched notification flagged for manual finance review.',
  };
}
