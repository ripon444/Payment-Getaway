import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, normalizeBdPhone, parseBdtAmount, sanitizeSensitiveContent } from './types.ts';

export class RocketParser implements MfsProviderParser {
  readonly provider = 'ROCKET' as const;
  readonly knownPackages = ['com.dbbl.mfs.rocket', 'com.dbbl.rocket'];

  canParse(input: RawNotificationInput): boolean {
    const pkg = input.packageName.toLowerCase();
    const combined = `${input.senderHeader ?? ''} ${input.title ?? ''} ${input.body}`.toLowerCase();
    return (
      this.knownPackages.some((p) => p.toLowerCase() === pkg) ||
      combined.includes('rocket') ||
      combined.includes('16216')
    );
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'ROCKET',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: null,
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'DBBL Rocket',
        reference: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'rocketParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    let txType: string | null = null;
    let accountMode: 'PERSONAL' | 'MERCHANT' = /merchant\s*pay/i.test(body) ? 'MERCHANT' : 'PERSONAL';

    if (/cash[\s-]*in/i.test(body)) txType = 'CASH_IN';
    else if (/merchant\s*pay/i.test(body)) txType = 'MERCHANT_PAY';
    else if (/received/i.test(body)) txType = 'P2P_RECEIVED';

    if (/\b(sent\s+to|cash[\s-]*out\s+to|debited)\b/i.test(body)) {
      warnings.push('Outgoing DBBL Rocket debit notification ignored');
      return {
        provider: 'ROCKET',
        parseStatus: 'UNPARSED',
        accountMode,
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: 'DBBL Rocket',
        reference: null,
        confidence: 15,
        redactedBody: body,
        parserModule: 'rocketParser',
        warnings,
      };
    }

    const amountMatch =
      body.match(/(?:Tk|BDT)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:received|credited|cash[\s-]*in)/i) ||
      body.match(/(?:Amount|Received)\s*[:#-]?\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i);

    const trxMatch = body.match(/\b(?:TxnId|TrxID|Txnid)\s*[:#-]?\s*([A-Z0-9]{6,16})\b/i);
    const senderMatch = body.match(/\bfrom\s+(?:A\/C\s*)?(?:\+?88)?(01\d{9,10})\b/i);
    const balanceMatch = body.match(/\bBalance\s*[:#-]?\s*(?:Tk|BDT)?\s*([\d,]+(?:\.\d{1,2})?)/i);
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

    if (!amountBdt) warnings.push('Missing Rocket BDT amount');
    if (!trxId) warnings.push('Missing Rocket TxnId');

    return {
      provider: 'ROCKET',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode,
      txType: txType ?? 'INCOMING',
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount: null,
      balanceBdt,
      bankName: 'DBBL Rocket',
      reference,
      confidence,
      redactedBody: body,
      parserModule: 'rocketParser',
      warnings,
    };
  }
}
