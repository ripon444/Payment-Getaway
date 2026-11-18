import { BanglaQrParser } from './banglaQrParser.ts';
import { BankSmsParser, type DynamicBankTemplate } from './bankSmsParser.ts';
import { BkashParser } from './bkashParser.ts';
import { CellfinParser } from './cellfinParser.ts';
import { NagadParser } from './nagadParser.ts';
import { RocketParser } from './rocketParser.ts';
import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, extractTransactionTime, sanitizeSensitiveContent } from './types.ts';
import { UpayParser } from './upayParser.ts';

export const bankSmsParserInstance = new BankSmsParser();

// Ordered carefully so specific providers (Upay, CellFin, Bangla QR) match before generic MFS/Bank fallbacks
const PARSERS: MfsProviderParser[] = [
  new UpayParser(),
  new CellfinParser(),
  new BanglaQrParser(),
  new BkashParser(),
  new NagadParser(),
  new RocketParser(),
  bankSmsParserInstance,
];

export function registerDynamicBankTemplates(templates: DynamicBankTemplate[]): void {
  bankSmsParserInstance.setDynamicTemplates(templates);
}

export function parseMfsNotification(input: RawNotificationInput): ParsedMfsNotification {
  const combined = `${input.title ?? ''} ${input.body}`.trim();

  if (containsSensitiveOtpOrPin(combined)) {
    return {
      provider: 'UNKNOWN',
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
      parserModule: 'securityFilter',
      warnings: ['OTP/PIN notification blocked before parsing'],
    };
  }

  for (const parser of PARSERS) {
    if (parser.canParse(input)) {
      return parser.parse(input);
    }
  }

  return {
    provider: 'UNKNOWN',
    parseStatus: 'UNPARSED',
    accountMode: null,
    txType: null,
    amountBdt: null,
    trxId: null,
    senderPhone: null,
    receiverAccount: null,
    balanceBdt: null,
    bankName: null,
    reference: null,
    transactionTime: extractTransactionTime(input.body, input.deviceTimestampMs),
    confidence: 0,
    redactedBody: sanitizeSensitiveContent(input.body),
    parserModule: 'none',
    warnings: ['Notification did not match any supported Bangladesh MFS, Bangla QR, CellFin, or Bank SMS provider'],
  };
}

export {
  BanglaQrParser,
  BankSmsParser,
  BkashParser,
  CellfinParser,
  NagadParser,
  RocketParser,
  UpayParser,
};
export type { ParsedMfsNotification, RawNotificationInput, ProviderCode, AccountMode } from './types.ts';
