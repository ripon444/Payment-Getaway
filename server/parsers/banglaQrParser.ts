import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import {
  containsSensitiveOtpOrPin,
  extractSmsSenderFromPackage,
  extractTransactionTime,
  normalizeBdPhone,
  parseBdtAmount,
  sanitizeSensitiveContent,
} from './types.ts';

const BANK_PATTERNS: Array<{ match: RegExp; name: string }> = [
  { match: /\bcity\s*bank|citytouch|citybank\b/i, name: 'The City Bank PLC' },
  { match: /\bbrac\s*bank|bracbank|astha\b/i, name: 'BRAC Bank PLC' },
  { match: /\bdbbl|dutch[\s-]*bangla|nexuspay\b/i, name: 'Dutch-Bangla Bank PLC' },
  { match: /\bebl|eastern\s*bank|skybanking\b/i, name: 'Eastern Bank PLC' },
  { match: /\bibbl|islami\s*bank\b/i, name: 'Islami Bank Bangladesh PLC' },
  { match: /\bprime\s*bank|primebank\b/i, name: 'Prime Bank PLC' },
  { match: /\bsonali\s*bank\b/i, name: 'Sonali Bank PLC' },
];

export class BanglaQrParser implements MfsProviderParser {
  readonly provider = 'BANGLA_QR' as const;
  readonly knownPackages = ['com.citybank.citytouch', 'com.bracbank.astha', 'com.dbbl.nexus.pay', 'com.ebl.skybanking'];

  canParse(input: RawNotificationInput): boolean {
    const senderHdr = extractSmsSenderFromPackage(input.packageName, input.senderHeader);
    const combined = `${senderHdr} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      combined.includes('banglaqr') ||
      combined.includes('bangla qr') ||
      combined.includes('npsb/qr') ||
      combined.includes('emvqr') ||
      (combined.includes('qr') && (combined.includes('credited') || combined.includes('received')))
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'BANGLA_QR',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: null,
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: null,
        reference: null,
        transactionTime: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'banglaQrParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    if (/\b(debited|paid\s+to|purchase\s+at)\b/i.test(body) && !/credited|received/i.test(body)) {
      warnings.push('Outgoing QR payment debit ignored');
      return {
        provider: 'BANGLA_QR',
        parseStatus: 'UNPARSED',
        accountMode: 'MERCHANT',
        txType: 'OUTGOING_QR_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: null,
        reference: null,
        transactionTime: extractTransactionTime(body, input.deviceTimestampMs),
        confidence: 15,
        redactedBody: body,
        parserModule: 'banglaQrParser',
        warnings,
      };
    }

    const senderHdr = extractSmsSenderFromPackage(input.packageName, input.senderHeader);
    const bankFound = BANK_PATTERNS.find((b) => b.match.test(`${senderHdr} ${body}`));
    const amountMatch = body.match(/(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const trxMatch = body.match(/\b(?:Desc|Ref|TrxID|TxnID|TxnId|RRN)\s*[:#-]?\s*(?:NPSB\/QR-)?([A-Z0-9-]{6,22})\b/i);
    const acctMatch = body.match(/\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i);
    const senderMatch = body.match(/\bfrom\s+(?:\+?88)?(01\d{9})\b/i);
    const balMatch = body.match(/\b(?:Avl\s*Bal|Bal|Balance)\s*[:#-]?\s*(?:BDT|Tk)?\s*([\d,]+(?:\.\d{1,2})?)/i);

    const amountBdt = parseBdtAmount(amountMatch?.[1]);
    const trxId = trxMatch?.[1]?.toUpperCase() ?? null;
    const receiverAccount = acctMatch?.[1] ?? null;
    const senderPhone = normalizeBdPhone(senderMatch?.[1]);
    const balanceBdt = parseBdtAmount(balMatch?.[1]);
    const transactionTime = extractTransactionTime(body, input.deviceTimestampMs);

    let confidence = 0;
    if (/credited|received/i.test(body)) confidence += 20;
    if (amountBdt !== null) confidence += 35;
    if (trxId) confidence += 30;
    if (receiverAccount || bankFound) confidence += 15;

    if (!amountBdt) warnings.push('Missing Bangla QR BDT amount');
    if (!trxId) warnings.push('Missing Bangla QR Ref/RRN/TrxID');

    return {
      provider: 'BANGLA_QR',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode: 'MERCHANT',
      txType: 'BANGLA_QR_CREDIT',
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount,
      balanceBdt,
      bankName: bankFound?.name ?? 'Bangla QR Participating Bank',
      reference: trxId,
      transactionTime,
      confidence: Math.min(100, confidence),
      redactedBody: body,
      parserModule: 'banglaQrParser',
      warnings,
    };
  }
}
