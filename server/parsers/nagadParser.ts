import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import {
  containsSensitiveOtpOrPin,
  extractMfsReceiverAccount,
  extractSmsSenderFromPackage,
  extractTransactionTime,
  normalizeBdPhone,
  parseBdtAmount,
  sanitizeSensitiveContent,
} from './types.ts';

export class NagadParser implements MfsProviderParser {
  readonly provider = 'NAGAD' as const;
  readonly knownPackages = ['com.konasl.nagad', 'com.konasl.nagad.uddokta'];

  canParse(input: RawNotificationInput): boolean {
    const pkg = input.packageName.toLowerCase();
    const senderHdr = extractSmsSenderFromPackage(input.packageName, input.senderHeader);
    const combined = `${senderHdr} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      this.knownPackages.some((p) => p.toLowerCase() === pkg) ||
      combined.includes('nagad') ||
      combined.includes('16167') ||
      /\bmoney\s+received\b.*\btxnid\b/i.test(input.body)
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'NAGAD',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: null,
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'Nagad',
        reference: null,
        transactionTime: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'nagadParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    let txType: string | null = null;
    let accountMode: 'PERSONAL' | 'MERCHANT' = /payment\s+received/i.test(body) ? 'MERCHANT' : 'PERSONAL';

    if (/money\s+received/i.test(body)) txType = 'MONEY_RECEIVED';
    else if (/payment\s+received/i.test(body)) txType = 'PAYMENT';
    else if (/cash[\s-]*in\s+received/i.test(body)) txType = 'CASH_IN';

    if (/\b(send\s+money\s+successful|cash\s*out\s+successful|payment\s+successful\s+to)\b/i.test(body)) {
      warnings.push('Outgoing Nagad debit notification ignored');
      return {
        provider: 'NAGAD',
        parseStatus: 'UNPARSED',
        accountMode,
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'Nagad',
        reference: null,
        transactionTime: extractTransactionTime(body, input.deviceTimestampMs),
        confidence: 15,
        redactedBody: body,
        parserModule: 'nagadParser',
        warnings,
      };
    }

    const amountMatch =
      body.match(/Amount\s*[:#-]?\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i) ||
      body.match(/received\s*(?:Tk|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i);

    const trxMatch = body.match(/\bTxnID\s*[:#-]?\s*([A-Z0-9]{7,16})\b/i);
    const senderMatch = body.match(/\b(?:Sender|From)\s*[:#-]?\s*(?:\+?88)?(01\d{9})\b/i);
    const balanceMatch = body.match(/\bBalance\s*[:#-]?\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const refMatch = body.match(/\bRef(?:erence)?\s*[:#-]?\s*([A-Za-z0-9_-]{2,32})\b/i);

    const amountBdt = parseBdtAmount(amountMatch?.[1]);
    const trxId = trxMatch?.[1]?.toUpperCase() ?? null;
    const senderPhone = normalizeBdPhone(senderMatch?.[1]);
    const receiverAccount = extractMfsReceiverAccount(body);
    const balanceBdt = parseBdtAmount(balanceMatch?.[1]);
    const reference = refMatch?.[1] ?? null;
    const transactionTime = extractTransactionTime(body, input.deviceTimestampMs);

    let confidence = 0;
    if (txType) confidence += 20;
    if (amountBdt !== null) confidence += 35;
    if (trxId) confidence += 35;
    if (senderPhone) confidence += 10;

    if (!amountBdt) warnings.push('Missing Nagad BDT amount');
    if (!trxId) warnings.push('Missing Nagad TxnID');

    return {
      provider: 'NAGAD',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode,
      txType: txType ?? 'INCOMING',
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount,
      balanceBdt,
      bankName: 'Nagad',
      reference,
      transactionTime,
      confidence,
      redactedBody: body,
      parserModule: 'nagadParser',
      warnings,
    };
  }
}
