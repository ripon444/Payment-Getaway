export type ProviderCode = 'BKASH' | 'NAGAD' | 'ROCKET';

export type ParseStatus = 'PARSED' | 'UNPARSED' | 'DUPLICATE' | 'IGNORED_SECURITY';

export interface RawNotificationInput {
  packageName: string;
  title?: string | null;
  body: string;
  senderHeader?: string | null;
  deviceTimestampMs?: number;
}

export interface ParsedMfsNotification {
  provider: ProviderCode | 'UNKNOWN';
  parseStatus: 'PARSED' | 'UNPARSED' | 'IGNORED_SECURITY';
  txType: string | null;
  amountBdt: number | null;
  trxId: string | null;
  senderPhone: string | null;
  receiverPhone: string | null;
  balanceBdt: number | null;
  reference: string | null;
  confidence: number;
  redactedBody: string;
  parserModule: string;
  warnings: string[];
}

export interface MfsProviderParser {
  readonly provider: ProviderCode;
  readonly knownPackages: string[];
  canParse(input: RawNotificationInput): boolean;
  parse(input: RawNotificationInput): ParsedMfsNotification;
}

const SENSITIVE_OTP_PATTERNS: RegExp[] = [
  /\b(otp|one[\s-]*time[\s-]*password|verification\s*code|pin\s*(?:is|:)|secret\s*code|security\s*code)\b/i,
  /\b(?:do\s+not\s+share|never\s+share)\b.*\b\d{4,6}\b/i,
];

export function containsSensitiveOtpOrPin(text: string): boolean {
  return SENSITIVE_OTP_PATTERNS.some((re) => re.test(text));
}

export function sanitizeSensitiveContent(text: string): string {
  // Strip any accidental OTP/PIN digits while keeping transaction IDs intact
  return text
    .replace(/\b(OTP|PIN|Code)\s*[:=-]?\s*\d{4,8}\b/gi, '$1: [REDACTED]')
    .trim();
}

export function normalizeBdPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('8801') && digits.length >= 13) {
    return digits.slice(2, 14); // 01XXXXXXXXX or 12-digit Rocket A/C
  }
  if (digits.startsWith('01') && (digits.length === 11 || digits.length === 12)) {
    return digits;
  }
  return digits.length >= 10 ? digits : null;
}

export function parseBdtAmount(raw?: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const num = Number.parseFloat(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100) / 100;
}
