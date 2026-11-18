import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, normalizeBdPhone, parseBdtAmount, sanitizeSensitiveContent } from './types.ts';

interface BankRuleProfile {
  bankName: string;
  senderMatch: RegExp;
  amountRegex: RegExp;
  trxRegex: RegExp;
  accountRegex: RegExp;
}

const BUILTIN_BANK_PROFILES: BankRuleProfile[] = [
  {
    bankName: 'The City Bank PLC',
    senderMatch: /\b(city\s*bank|citybank|citytouch)\b/i,
    amountRegex: /(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:Ref|TrxID|TxnID)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
  {
    bankName: 'BRAC Bank PLC',
    senderMatch: /\b(brac\s*bank|bracbank|astha)\b/i,
    amountRegex: /(?:Tk|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:Desc|Ref|TrxID)\s*[:#-]?\s*(?:NPSB\/(?:QR-)?)?([A-Z0-9-]{6,22})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
  {
    bankName: 'Dutch-Bangla Bank PLC',
    senderMatch: /\b(dbbl|dutch[\s-]*bangla|nexuspay)\b/i,
    amountRegex: /(?:Tk|BDT)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:TxnId|TrxID|Ref)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
  {
    bankName: 'Eastern Bank PLC',
    senderMatch: /\b(ebl|eastern\s*bank|skybanking)\b/i,
    amountRegex: /(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:Ref|TrxID|TxnID)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
  {
    bankName: 'Prime Bank PLC',
    senderMatch: /\b(prime\s*bank|primebank|myprime)\b/i,
    amountRegex: /(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:Ref|TrxID|TxnID)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
  {
    bankName: 'Sonali Bank PLC',
    senderMatch: /\b(sonali\s*bank|sonali\s*esheba)\b/i,
    amountRegex: /(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i,
    trxRegex: /\b(?:Ref|TrxID|TxnID)\s*[:#-]?\s*([A-Z0-9-]{6,20})\b/i,
    accountRegex: /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i,
  },
];

export interface DynamicBankTemplate {
  bank_name: string;
  sender_id: string;
  amount_regex: string;
  trx_regex: string;
  account_regex?: string | null;
}

export class BankSmsParser implements MfsProviderParser {
  readonly provider = 'BANK_SMS' as const;
  readonly knownPackages = [
    'com.citybank.citytouch',
    'com.bracbank.astha',
    'com.dbbl.nexus.pay',
    'com.ebl.skybanking',
    'com.primebank.myprime',
  ];

  private dynamicTemplates: DynamicBankTemplate[] = [];

  setDynamicTemplates(templates: DynamicBankTemplate[]): void {
    this.dynamicTemplates = templates;
  }

  canParse(input: RawNotificationInput): boolean {
    const combined = `${input.senderHeader ?? ''} ${input.title ?? ''} ${input.body}`;
    if (BUILTIN_BANK_PROFILES.some((p) => p.senderMatch.test(combined))) {
      return true;
    }
    if (this.dynamicTemplates.some((t) => combined.toLowerCase().includes(t.sender_id.toLowerCase()) || combined.toLowerCase().includes(t.bank_name.toLowerCase()))) {
      return true;
    }
    return /\b(a\/c|account)\b.*\b(credited|deposited)\b.*\b(bdt|tk)\b/i.test(combined);
  }

  parse(input: RawNotificationInput): ParsedMfsNotification {
    const combined = `${input.title ?? ''} ${input.body}`.trim();

    if (containsSensitiveOtpOrPin(combined)) {
      return {
        provider: 'BANK_SMS',
        parseStatus: 'IGNORED_SECURITY',
        accountMode: 'BANK_ACCOUNT',
        txType: null,
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: null,
        reference: null,
        confidence: 0,
        redactedBody: '[REDACTED_OTP_OR_PIN_NOTIFICATION]',
        parserModule: 'bankSmsParser',
        warnings: ['Security filter blocked OTP/PIN notification'],
      };
    }

    const body = sanitizeSensitiveContent(input.body);
    const warnings: string[] = [];

    if (/\b(debited|withdrawn|atm\s*wdl|pos\s*txn)\b/i.test(body) && !/credited|deposited/i.test(body)) {
      warnings.push('Outgoing bank account debit alert ignored');
      return {
        provider: 'BANK_SMS',
        parseStatus: 'UNPARSED',
        accountMode: 'BANK_ACCOUNT',
        txType: 'OUTGOING_DEBIT',
        amountBdt: null,
        trxId: null,
        senderPhone: null,
        receiverAccount: null,
        balanceBdt: null,
        bankName: null,
        reference: null,
        confidence: 15,
        redactedBody: body,
        parserModule: 'bankSmsParser',
        warnings,
      };
    }

    const headerAndBody = `${input.senderHeader ?? ''} ${body}`;

    // 1. Check dynamic DB templates first
    for (const tpl of this.dynamicTemplates) {
      if (
        headerAndBody.toLowerCase().includes(tpl.sender_id.toLowerCase()) ||
        headerAndBody.toLowerCase().includes(tpl.bank_name.toLowerCase())
      ) {
        try {
          const amtRe = new RegExp(tpl.amount_regex, 'i');
          const trxRe = new RegExp(tpl.trx_regex, 'i');
          const acctRe = tpl.account_regex ? new RegExp(tpl.account_regex, 'i') : /\bA\/C\s*([*\d]{4,18})/i;

          const amountBdt = parseBdtAmount(body.match(amtRe)?.[1]);
          const trxId = body.match(trxRe)?.[1]?.toUpperCase() ?? null;
          const receiverAccount = body.match(acctRe)?.[1] ?? null;
          const senderPhone = normalizeBdPhone(body.match(/\bfrom\s+(?:\+?88)?(01\d{9})\b/i)?.[1]);
          const balMatch = body.match(/\b(?:Avl\s*Bal|Bal|Balance)\s*[:#-]?\s*(?:BDT|Tk)?\s*([\d,]+(?:\.\d{1,2})?)/i);

          let confidence = 0;
          if (/credited|deposited|received/i.test(body)) confidence += 20;
          if (amountBdt !== null) confidence += 35;
          if (trxId) confidence += 30;
          if (receiverAccount) confidence += 15;

          if (!amountBdt) warnings.push('Missing Bank SMS amount');
          if (!trxId) warnings.push('Missing Bank SMS Ref/TrxID');

          return {
            provider: 'BANK_SMS',
            parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
            accountMode: 'BANK_ACCOUNT',
            txType: 'BANK_CREDIT',
            amountBdt,
            trxId,
            senderPhone,
            receiverAccount,
            balanceBdt: parseBdtAmount(balMatch?.[1]),
            bankName: tpl.bank_name,
            reference: trxId,
            confidence: Math.min(100, confidence),
            redactedBody: body,
            parserModule: `bankSmsParser:${tpl.sender_id}`,
            warnings,
          };
        } catch {
          // Fall through to built-in profiles on malformed custom regex
        }
      }
    }

    // 2. Built-in Bangladesh bank profiles
    const profile = BUILTIN_BANK_PROFILES.find((p) => p.senderMatch.test(headerAndBody));
    const amountRegex = profile?.amountRegex ?? /(?:BDT|Tk)\s*([\d,]+(?:\.\d{1,2})?)/i;
    const trxRegex = profile?.trxRegex ?? /\b(?:Ref|TrxID|TxnID|TxnId|Desc)\s*[:#-]?\s*([A-Z0-9-]{6,22})\b/i;
    const accountRegex = profile?.accountRegex ?? /\bA\/C\s*[:#-]?\s*([*\d]{4,18})\b/i;

    const amountBdt = parseBdtAmount(body.match(amountRegex)?.[1]);
    const trxId = body.match(trxRegex)?.[1]?.toUpperCase() ?? null;
    const receiverAccount = body.match(accountRegex)?.[1] ?? null;
    const senderPhone = normalizeBdPhone(body.match(/\bfrom\s+(?:\+?88)?(01\d{9})\b/i)?.[1]);
    const balMatch = body.match(/\b(?:Avl\s*Bal|Bal|Balance)\s*[:#-]?\s*(?:BDT|Tk)?\s*([\d,]+(?:\.\d{1,2})?)/i);

    let confidence = 0;
    if (/credited|deposited|received/i.test(body)) confidence += 20;
    if (amountBdt !== null) confidence += 35;
    if (trxId) confidence += 30;
    if (receiverAccount) confidence += 15;

    if (!amountBdt) warnings.push('Missing Bank SMS BDT amount');
    if (!trxId) warnings.push('Missing Bank SMS reference/TrxID');

    return {
      provider: 'BANK_SMS',
      parseStatus: amountBdt !== null && trxId !== null ? 'PARSED' : 'UNPARSED',
      accountMode: 'BANK_ACCOUNT',
      txType: 'BANK_CREDIT',
      amountBdt,
      trxId,
      senderPhone,
      receiverAccount,
      balanceBdt: parseBdtAmount(balMatch?.[1]),
      bankName: profile?.bankName ?? 'Bangladesh Commercial Bank',
      reference: trxId,
      confidence: Math.min(100, confidence),
      redactedBody: body,
      parserModule: 'bankSmsParser',
      warnings,
    };
  }
}
