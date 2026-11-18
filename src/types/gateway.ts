export type UserRole = 'SUPER_ADMIN' | 'FINANCE_REVIEWER' | 'OPERATIONS' | 'MERCHANT_ADMIN';

export type ProviderCode =
  | 'BKASH'
  | 'NAGAD'
  | 'ROCKET'
  | 'UPAY'
  | 'CELLFIN'
  | 'BANGLA_QR'
  | 'BANK_SMS';

export const ALL_PROVIDERS: Array<{ code: ProviderCode; label: string }> = [
  { code: 'BKASH', label: 'bKash' },
  { code: 'NAGAD', label: 'Nagad' },
  { code: 'ROCKET', label: 'DBBL Rocket' },
  { code: 'UPAY', label: 'Upay' },
  { code: 'CELLFIN', label: 'Islami Bank CellFin' },
  { code: 'BANGLA_QR', label: 'Bangla QR' },
  { code: 'BANK_SMS', label: 'Bank SMS' },
];

export type PaymentStatus =
  | 'PENDING'
  | 'DETECTED'
  | 'MATCHED'
  | 'REVIEW_REQUIRED'
  | 'VERIFIED'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  merchantId: string | null;
}

export interface MerchantRow {
  id: string;
  name: string;
  slug: string;
  business_type: string;
  contact_email: string;
  webhook_url: string | null;
  api_key_prefix: string;
  settlement_mode: string;
  fee_percent: number;
  settled_balance_bdt: number;
  pending_balance_bdt: number;
  status: string;
  active_wallets: number;
  active_websites: number;
  total_payments: number;
  created_at: string;
}

export interface MerchantWebsiteRow {
  id: string;
  merchant_id: string;
  merchant_name?: string;
  site_name: string;
  domain: string;
  platform: 'CUSTOM' | 'WOOCOMMERCE' | 'SHOPIFY' | 'LARAVEL';
  callback_url: string | null;
  is_active: number;
  created_at: string;
}

export interface MfsWalletRow {
  id: string;
  merchant_id: string;
  merchant_name?: string;
  provider: ProviderCode;
  account_number: string;
  account_type: string;
  account_title: string;
  bank_name?: string | null;
  bangla_qr_payload?: string | null;
  daily_limit_bdt: number;
  daily_received_bdt: number;
  is_active: number;
}

export interface DeviceRow {
  id: string;
  merchant_id: string | null;
  merchant_name: string | null;
  device_uid: string | null;
  device_name: string;
  android_model: string | null;
  android_version: string | null;
  app_version: string | null;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  assignedProviders: ProviderCode[];
  simSlots: Array<{ slot: number; carrier: string; number?: string }>;
  assignedWallets: Array<{
    device_id: string;
    wallet_id: string;
    provider: ProviderCode;
    account_number: string;
    sim_slot?: number | null;
  }>;
  status: 'PENDING_PAIRING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  last_heartbeat_at: string | null;
  battery_pct: number | null;
  network_type: string | null;
  queue_depth: number;
  created_at: string;
}

export interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  website_id?: string | null;
  wallet_id: string | null;
  wallet_number: string | null;
  wallet_type: string | null;
  wallet_bank_name?: string | null;
  merchant_order_id: string;
  provider: ProviderCode;
  account_mode?: string;
  amount_bdt: number;
  currency: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  reference_code: string;
  bangla_qr_string?: string | null;
  submitted_trx_id: string | null;
  submitted_sender_phone: string | null;
  submitted_at: string | null;
  status: PaymentStatus;
  match_confidence: number | null;
  matched_notification_id: string | null;
  fraud_flags_json?: string | null;
  detected_at?: string | null;
  matched_at?: string | null;
  verified_at?: string | null;
  settled_at?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationEventRow {
  id: string;
  device_id: string;
  device_name?: string;
  device_uid?: string;
  merchant_id: string | null;
  source_channel?: 'NOTIFICATION' | 'SMS';
  sim_slot?: number | null;
  package_name: string;
  sender_header?: string | null;
  provider: string;
  event_uid: string;
  raw_title: string | null;
  raw_body_redacted: string;
  parsed_amount_bdt: number | null;
  parsed_trx_id: string | null;
  parsed_sender_phone: string | null;
  parsed_receiver_account?: string | null;
  parsed_balance_bdt: number | null;
  parsed_tx_type: string | null;
  parsed_bank_name?: string | null;
  parser_module?: string | null;
  parser_confidence: number;
  parse_status: 'PARSED' | 'UNPARSED' | 'DUPLICATE' | 'IGNORED_SECURITY';
  duplicate_of_event_id: string | null;
  candidate_payment_id: string | null;
  device_timestamp_ms: number;
  received_at: string;
}

export interface ProviderConfigRow {
  provider_code: ProviderCode;
  display_name: string;
  supports_personal: number;
  supports_merchant: number;
  supports_api_verification: number;
  bangla_qr_reliable: number;
  reliability_notes: string;
  is_enabled: number;
  updated_at: string;
}

export interface BankSmsTemplateRow {
  id: string;
  bank_name: string;
  sender_id: string;
  provider_code: string;
  sample_sms: string;
  amount_regex: string;
  trx_regex: string;
  account_regex: string | null;
  bangla_qr_capable: number;
  is_active: number;
  created_at: string;
}

export interface FraudAlertRow {
  id: string;
  merchant_id: string | null;
  merchant_name?: string | null;
  payment_intent_id: string | null;
  device_id: string | null;
  alert_type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  details_json: string | null;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  created_at: string;
}

export interface ApiUsageLogRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  endpoint: string;
  method: string;
  status_code: number;
  latency_ms: number;
  created_at: string;
}

export interface ApiUsageSummaryRow {
  endpoint: string;
  calls: number;
  avg_latency_ms: number;
}

export interface SystemHealthData {
  ok: boolean;
  dialect: 'mysql' | 'sqlite';
  nodeVersion: string;
  uptimeSec: number;
  memoryMb: number;
  loadAvg: number[];
  timestamp: string;
}

export interface WebhookDeliveryRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  payment_intent_id: string;
  merchant_order_id: string;
  event_type: string;
  target_url: string;
  payload_json: string;
  signature_header: string;
  attempt_count: number;
  http_status: number | null;
  response_body: string | null;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD_LETTER';
  next_retry_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  actor_type: string;
  actor_id: string;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  ip_address: string | null;
  before_state_json: string | null;
  after_state_json: string | null;
  created_at: string;
}
