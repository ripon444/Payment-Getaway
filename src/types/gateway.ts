export type UserRole = 'SUPER_ADMIN' | 'FINANCE_REVIEWER' | 'OPERATIONS' | 'MERCHANT_ADMIN';
export type ProviderCode = 'BKASH' | 'NAGAD' | 'ROCKET';
export type PaymentStatus =
  | 'CREATED'
  | 'CUSTOMER_SUBMITTED'
  | 'CANDIDATE_MATCHED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'VERIFIED_SETTLED'
  | 'REJECTED'
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
  status: string;
  active_wallets: number;
  total_payments: number;
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
  assignedWallets: Array<{
    device_id: string;
    wallet_id: string;
    provider: ProviderCode;
    account_number: string;
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
  wallet_id: string | null;
  wallet_number: string | null;
  wallet_type: string | null;
  merchant_order_id: string;
  provider: ProviderCode;
  amount_bdt: number;
  currency: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  reference_code: string;
  submitted_trx_id: string | null;
  submitted_sender_phone: string | null;
  submitted_at: string | null;
  status: PaymentStatus;
  match_confidence: number | null;
  matched_notification_id: string | null;
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
  package_name: string;
  provider: string;
  event_uid: string;
  raw_title: string | null;
  raw_body_redacted: string;
  parsed_amount_bdt: number | null;
  parsed_trx_id: string | null;
  parsed_sender_phone: string | null;
  parsed_balance_bdt: number | null;
  parsed_tx_type: string | null;
  parser_confidence: number;
  parse_status: 'PARSED' | 'UNPARSED' | 'DUPLICATE' | 'IGNORED_SECURITY';
  duplicate_of_event_id: string | null;
  candidate_payment_id: string | null;
  device_timestamp_ms: number;
  received_at: string;
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
