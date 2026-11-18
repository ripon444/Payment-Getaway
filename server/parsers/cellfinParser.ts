import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, normalizeBdPhone, parseBdtAmount, sanitizeSensitiveContent } from './types.ts';

export class CellfinParser implements MfsProviderParser {
  readonly provider = 'CELLFIN' as const;
  readonly knownPackages = ['com.ibbl.cellfin', 'com.islamibank.cellfin'];

  canParse(input: RawNotificationInput): boolean {
    const pkg = input.packageName.toLowerCase();
    const combined = `${input.senderHeader ?? ''} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      this.knownPackages.some((p) => p.toLowerCase() === pkg) ||
      combined.includes('cellfin') ||
      (combined.includes('ibbl') && combined.includes('credited'))
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'CELLFIN',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: null,
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'Islami Bank Bangladesh PLC',
        reference: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'cellfinParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    if (/\b(debited|transferred\s+from\s+your\s+a\/c|paid\s+to)\b/i.test(body)) {
      warnings.push('Outgoing CellFin debit alert ignored');
      return {
        provider: 'CELLFIN',
        parseStatus: 'UNPARSED',
        accountMode: 'BANK_ACCOUNT',
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'Islami Bank Bangladesh PLC',
        reference: null,
        confidence: 15,
        redactedBody: body,
        parserModule: 'cellfinParser',
        warnings,
      };
    }

    const amountMatch = body.match(/(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const trxMatch = body.match(/\b(?:TrxID|TxnID|Ref|TxRef)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i);
    const acctMatch = body.match(/\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i);
    const senderMatch = body.match(/\bfrom\s+(?:\+?88)?(01\d{9})\b/i);
    const balMatch = body.match(/\b(?:Bal|Balance)\s*[:#-]?\s*(?:BDT|Tk)?\s*([\d,]+(?:\.\d{1,2})?)/i);

    const amountBdt = parseBdtAmount(amountMatch?.[1]);
    const trxId = trxMatch?.[1]?.toUpperCase() ?? null;
    const receiverAccount = acctMatch?.[1] ?? null;
    const senderPhone = normalizeBdPhone(senderMatch?.[1]);
    const balanceBdt = parseBdtAmount(balMatch?.[1]);

    const txType = /qr/i.test(body) ? 'CELLFIN_QR_CREDIT' : 'CELLFIN_TRANSFER_CREDIT';

    let confidence = 0;
    if (/credited|received/i.test(body)) confidence += 20;
    if (amountBdt !== null) confidence += 35;
    if (trxId) confidence += 30;
    if (receiverAccount) confidence += 15;

    if (!amountBdt) warnings.push('Missing CellFin BDT amount');
    if (!trxId) warnings.push('Missing CellFin TrxID/Ref');

    return {
      provider: 'CELLFIN',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode: 'BANK_ACCOUNT',
      txType,
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount,
      balanceBdt,
      bankName: 'Islami Bank Bangladesh PLC',
      reference: trxId,
      confidence: Math.min(100, confidence),
      redactedBody: body,
      parserModule: 'cellfinParser',
      warnings,
    };
  }
}
