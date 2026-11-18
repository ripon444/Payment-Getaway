import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, normalizeBdPhone, parseBdtAmount, sanitizeSensitiveContent } from './types.ts';

export class BkashParser implements MfsProviderParser {
  readonly provider = 'BKASH' as const;
  readonly knownPackages = ['com.bKash.customerapp', 'com.bkash.businessapp', 'com.bkash.merchant'];

  canParse(input: RawNotificationInput): boolean {
    const pkg = input.packageName.toLowerCase();
    const combined = `${input.senderHeader ?? ''} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      this.knownPackages.some((p) => p.toLowerCase() === pkg) ||
      combined.includes('bkash') ||
      combined.includes('16247') ||
      /\btrxid\s+[a-z0-9]{8,12}\b/i.test(input.body)
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'BKASH',
        parseStatus: 'IGNORED_SECURITY',
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverPhone: null,
        balanceBdt: null,
        reference: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'bkashParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    // Detect incoming credit transaction type
    let txType: string | null = null;
    if (/received\s+payment/i.test(body)) txType = 'PAYMENT';
    else if (/cash\s*in\s+tk/i.test(body) || /received\s+cash\s*in/i.test(body)) txType = 'CASH_IN';
    else if (/you\s+have\s+received\s+tk/i.test(body)) txType = 'SEND_MONEY';
    else if (/পেয়েছেন|টাকা\s+পাঠানো\s+হয়েছে/i.test(body)) txType = 'INCOMING_BN';

    // Reject outgoing debit notifications from candidate matching
    if (/\b(you\s+have\s+sent|cash\s*out|payment\s+of\s+tk\s+[\d,.]+\s+to)\b/i.test(body)) {
      warnings.push('Outgoing debit notification detected; ignored for incoming payment matching');
      return {
        provider: 'BKASH',
        parseStatus: 'UNPARSED',
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverPhone: null,
        balanceBdt: null,
        reference: null,
        confidence: 15,
        redactedBody: body,
        parserModule: 'bkashParser',
        warnings,
      };
    }

    const amountMatch =
      body.match(/(?:received(?:\s+payment|\s+cash\s*in)?|cash\s*in)\s*(?:of\s*)?(?:tk|bdt)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
      body.match(/(?:tk|bdt)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:received|পেয়েছেন)/i);

    const trxMatch = body.match(/\bTrxID\s*[:#-]?\s*([A-Z0-9]{8,14})\b/i);
    const senderMatch = body.match(/\bfrom\s+(?:\+?88)?(01\d{9})\b/i);
    const balanceMatch = body.match(/\bBalance\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const refMatch = body.match(/\bRef(?:erence)?\s*[:#-]?\s*([A-Za-z0-9_-]{2,32})\b/i);

    const amountBdt = parseBdtAmount(amountMatch?.[1]);
    const trxId = trxMatch?.[1]?.toUpperCase() ?? null;
    const senderPhone = normalizeBdPhone(senderMatch?.[1]);
    const balanceBdt = parseBdtAmount(balanceMatch?.[1]);
    const reference = refMatch?.[1] ?? null;

    let confidence = 0;
    if (txType) confidence += 20;
    if (amountBdt !== null) confidence += 35;
    if (trxId) confidence += 35;
    if (senderPhone) confidence += 10;

    if (!amountBdt) warnings.push('Missing bKash BDT amount');
    if (!trxId) warnings.push('Missing bKash TrxID');

    const parseStatus = amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED';

    return {
      provider: 'BKASH',
      parseStatus,
      txType: txType ?? 'INCOMING',
      amountBdt,
      trxId,
      senderPhone,
      receiverPhone: null,
      balanceBdt,
      reference,
      confidence,
      redactedBody: body,
      parserModule: 'bkashParser',
      warnings,
    };
  }
}
