export type ProviderCode =
  | 'BKASH'
  | 'NAGAD'
  | 'ROCKET'
  | 'UPAY'
  | 'CELLFIN'
  | 'BANGLA_QR'
  | 'BANK_SMS';

export type AccountMode = 'PERSONAL' | 'MERCHANT' | 'BANK_ACCOUNT';

export type ParseStatus = 'PARSED' | 'UNPARSED' | 'DUPLICATE' | 'IGNORED_SECURITY';

export interface RawNotificationInput {
  packageName: string;
  title?: string | null;
  body: string;
  senderHeader?: string | null;
  sourceChannel?: 'NOTIFICATION' | 'SMS';
  simSlot?: number | null;
  deviceTimestampMs?: number;
}

export interface ParsedMfsNotification {
  provider: ProviderCode | 'UNKNOWN';
  parseStatus: 'PARSED' | 'UNPARSED' | 'IGNORED_SECURITY';
  accountMode: AccountMode | null;
  txType: string | null;
  amountBdt: number | null;
  trxId: string | null;
  senderPhone: string | null;
  receiverAccount: string | null;
  balanceBdt: number | null;
  bankName: string | null;
  reference: string | null;
  transactionTime: string | null;
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
  return text
    .replace(/\b(OTP|PIN|Code)\s*[:=-]?\s*\d{4,8}\b/gi, '$1: [REDACTED]')
    .trim();
}

export function normalizeBdPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('8801') && digits.length >= 13) {
    return digits.slice(2, 14);
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

export function extractSmsSenderFromPackage(packageName?: string | null, senderHeader?: string | null): string {
  const trimmedHeader = (senderHeader ?? '').trim();
  if (trimmedHeader) return trimmedHeader;
  const pkg = (packageName ?? '').trim();
  if (pkg.toLowerCase().startsWith('sms:')) {
    return pkg.slice(4).trim();
  }
  return '';
}

export function extractMfsReceiverAccount(body: string): string | null {
  const m =
    body.match(/\bto\s+(?:A\/C\s*)?(?:\+?88)?(01\d{9,10})\b/i) ||
    body.match(/\b(?:to|receiver|credited\s+to)\s+A\/C\s*[:#-]?\s*([*\d]{4,18})\b/i) ||
    body.match(/\bMerchant\s*[:#-]?\s*([A-Za-z0-9*_-]{4,20})\b/i);
  return m?.[1]?.trim() ?? null;
}

export function extractTransactionTime(body: string, deviceTimestampMs?: number): string | null {
  const patterns: RegExp[] = [
    // e.g. at 17/11/2026 23:40 or Date: 17-11-2026 02:15 PM or on 17/11/26 14:20:05
    /\b(?:at|on|date|time)?\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?)/i,
    // e.g. on 17-Nov-26 14:22 or 17-Nov-2026 02:15 PM
    /\b(?:on|at|date)?\s*[:#-]?\s*(\d{1,2}[-\s][A-Za-z]{3}[-\s]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?)/i,
    // e.g. 2026-11-17 14:22:10
    /\b(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?)\b/,
  ];

  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) {
      return m[1].trim();
    }
  }

  if (typeof deviceTimestampMs === 'number' && Number.isFinite(deviceTimestampMs) && deviceTimestampMs > 0) {
    return new Date(deviceTimestampMs).toISOString();
  }
  return null;
}
