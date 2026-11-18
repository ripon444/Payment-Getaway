import { BkashParser } from './bkashParser.ts';
import { NagadParser } from './nagadParser.ts';
import { RocketParser } from './rocketParser.ts';
import type { MfsProviderParser, ParsedMfsNotification, RawNotificationInput } from './types.ts';
import { containsSensitiveOtpOrPin, sanitizeSensitiveContent } from './types.ts';

const PARSERS: MfsProviderParser[] = [
  new BkashParser(),
  new NagadParser(),
  new RocketParser(),
];

export function parseMfsNotification(input: RawNotificationInput): ParsedMfsNotification {
  const combined = `${input.title ?? ''} ${input.body}`.trim();

  if (containsSensitiveOtpOrPin(combined)) {
    return {
      provider: 'UNKNOWN',
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
    txType: null,
    amountBdt: null,
    trxId: null,
    senderPhone: null,
    receiverPhone: null,
    balanceBdt: null,
    reference: null,
    confidence: 0,
    redactedBody: sanitizeSensitiveContent(input.body),
    parserModule: 'none',
    warnings: ['Notification did not match bKash, Nagad, or Rocket provider signatures'],
  };
}

export { BkashParser, NagadParser, RocketParser };
export type { ParsedMfsNotification, RawNotificationInput, ProviderCode } from './types.ts';
