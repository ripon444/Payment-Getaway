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

export class UpayParser implements MfsProviderParser {
  readonly provider = 'UPAY' as const;
  readonly knownPackages = ['com.ucb.upay', 'bd.com.upay.customer', 'bd.com.upay.agent', 'bd.com.upay.merchant'];

  canParse(input: RawNotificationInput): boolean {
    const pkg = input.packageName.toLowerCase();
    const senderHdr = extractSmsSenderFromPackage(input.packageName, input.senderHeader);
    const combined = `${senderHdr} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      this.knownPackages.some((p) => p.toLowerCase() === pkg) ||
      combined.includes('upay') ||
      combined.includes('16268')
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'UPAY',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: null,
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'UCB Upay',
        reference: null,
        transactionTime: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'upayParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];
    const pkg = input.packageName.toLowerCase();

    let txType: string | null = null;
    let accountMode: 'PERSONAL' | 'MERCHANT' =
      pkg.includes('merchant') || /received\s+payment/i.test(body) ? 'MERCHANT' : 'PERSONAL';

    if (/received\s+payment/i.test(body)) txType = 'PAYMENT';
    else if (/cash[\s-]*in/i.test(body)) txType = 'CASH_IN';
    else if (/received\s+(?:tk|bdt)/i.test(body)) txType = 'SEND_MONEY';

    if (/\b(you\s+have\s+sent|cash[\s-]*out|paid\s+(?:tk|bdt))\b/i.test(body)) {
      warnings.push('Outgoing Upay debit notification ignored');
      return {
        provider: 'UPAY',
        parseStatus: 'UNPARSED',
        accountMode,
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'UCB Upay',
        reference: null,
        transactionTime: extractTransactionTime(body, input.deviceTimestampMs),
        confidence: 15,
        redactedBody: body,
        parserModule: 'upayParser',
        warnings,
      };
    }

    const amountMatch =
      body.match(/(?:received(?:\s+payment|\s+cash[\s-]*in)?|amount\s*[:#-]?)\s*(?:tk|bdt)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
      body.match(/(?:tk|bdt)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:received|credited)/i);

    const trxMatch = body.match(/\b(?:TrxID|TxnID|Trx\s*ID)\s*[:#-]?\s*([A-Z0-9]{6,18})\b/i);
    const senderMatch = body.match(/\b(?:from|sender)\s*[:#-]?\s*(?:\+?88)?(01\d{9})\b/i);
    const balanceMatch = body.match(/\b(?:Balance|Bal)\s*[:#-]?\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i);
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

    if (!amountBdt) warnings.push('Missing Upay BDT amount');
    if (!trxId) warnings.push('Missing Upay TrxID');

    return {
      provider: 'UPAY',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode,
      txType: txType ?? 'INCOMING',
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount,
      balanceBdt,
      bankName: 'UCB Upay',
      reference,
      transactionTime,
      confidence,
      redactedBody: body,
      parserModule: 'upayParser',
      warnings,
    };
  }
}
