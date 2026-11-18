-- TakaLedger Bangladesh Multi-Merchant MFS Payment Gateway
-- Production MySQL 8.0+ Schema
-- Charset: utf8mb4_unicode_ci | Engine: InnoDB

CREATE DATABASE IF NOT EXISTS takaledger_gateway
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE takaledger_gateway;

-- 1. Merchants
CREATE TABLE IF NOT EXISTS merchants (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  business_type VARCHAR(80) NOT NULL DEFAULT 'ECOMMERCE',
  contact_email VARCHAR(190) NOT NULL,
  webhook_url VARCHAR(500) NULL,
  webhook_secret_enc TEXT NULL,
  api_key_prefix VARCHAR(16) NOT NULL,
  api_key_hash CHAR(64) NOT NULL UNIQUE,
  allowed_ips_json JSON NULL,
  settlement_mode ENUM('PROVIDER_API_OR_MANUAL', 'MANUAL_ONLY') NOT NULL DEFAULT 'PROVIDER_API_OR_MANUAL',
  status ENUM('ACTIVE', 'SUSPENDED', 'PENDING') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_merchants_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Platform & Merchant Users (RBAC)
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('SUPER_ADMIN', 'FINANCE_REVIEWER', 'OPERATIONS', 'MERCHANT_ADMIN') NOT NULL,
  merchant_id VARCHAR(36) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_users_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  INDEX idx_users_role (role),
  INDEX idx_users_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. MFS Receiving Wallets (bKash, Nagad, Rocket)
CREATE TABLE IF NOT EXISTS mfs_wallets (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  provider ENUM('BKASH', 'NAGAD', 'ROCKET') NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  account_type ENUM('PERSONAL', 'AGENT', 'MERCHANT') NOT NULL DEFAULT 'MERCHANT',
  account_title VARCHAR(120) NOT NULL,
  daily_limit_bdt DECIMAL(14, 2) NOT NULL DEFAULT 250000.00,
  daily_received_bdt DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_wallets_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  UNIQUE KEY uq_wallet_provider_number (provider, account_number),
  INDEX idx_wallets_merchant_provider (merchant_id, provider, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Android Notification Agent Devices
CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NULL,
  device_uid VARCHAR(128) NULL UNIQUE,
  device_name VARCHAR(120) NOT NULL,
  android_model VARCHAR(120) NULL,
  android_version VARCHAR(40) NULL,
  app_version VARCHAR(40) NULL,
  pairing_code VARCHAR(16) NULL UNIQUE,
  pairing_expires_at DATETIME(3) NULL,
  device_token_hash CHAR(64) NULL UNIQUE,
  hmac_secret_enc TEXT NULL,
  assigned_providers_json JSON NOT NULL,
  status ENUM('PENDING_PAIRING', 'ACTIVE', 'SUSPENDED', 'REVOKED') NOT NULL DEFAULT 'PENDING_PAIRING',
  last_heartbeat_at DATETIME(3) NULL,
  battery_pct INT NULL,
  network_type VARCHAR(32) NULL,
  queue_depth INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_devices_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  INDEX idx_devices_status (status),
  INDEX idx_devices_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Device <-> Wallet Assignment Mapping
CREATE TABLE IF NOT EXISTS device_wallets (
  device_id VARCHAR(36) NOT NULL,
  wallet_id VARCHAR(36) NOT NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (device_id, wallet_id),
  CONSTRAINT fk_dw_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_dw_wallet FOREIGN KEY (wallet_id) REFERENCES mfs_wallets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Payment Intents (Checkout Sessions & Merchant Orders)
CREATE TABLE IF NOT EXISTS payment_intents (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  wallet_id VARCHAR(36) NULL,
  merchant_order_id VARCHAR(120) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  provider ENUM('BKASH', 'NAGAD', 'ROCKET') NOT NULL,
  amount_bdt DECIMAL(12, 2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'BDT',
  customer_name VARCHAR(120) NULL,
  customer_phone VARCHAR(24) NULL,
  customer_email VARCHAR(190) NULL,
  reference_code VARCHAR(64) NOT NULL,
  submitted_trx_id VARCHAR(64) NULL,
  submitted_sender_phone VARCHAR(24) NULL,
  submitted_at DATETIME(3) NULL,
  status ENUM(
    'CREATED',
    'CUSTOMER_SUBMITTED',
    'CANDIDATE_MATCHED',
    'MANUAL_REVIEW_REQUIRED',
    'VERIFIED_SETTLED',
    'REJECTED',
    'EXPIRED'
  ) NOT NULL DEFAULT 'CREATED',
  match_confidence INT NULL,
  matched_notification_id VARCHAR(36) NULL,
  metadata_json JSON NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pi_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pi_wallet FOREIGN KEY (wallet_id) REFERENCES mfs_wallets(id) ON DELETE SET NULL,
  UNIQUE KEY uq_pi_merchant_order (merchant_id, merchant_order_id),
  UNIQUE KEY uq_pi_idempotency (merchant_id, idempotency_key),
  INDEX idx_pi_status (status),
  INDEX idx_pi_provider_amount (provider, amount_bdt, status),
  INDEX idx_pi_submitted_trx (submitted_trx_id),
  INDEX idx_pi_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Raw & Parsed Android Notification Events (Never Proof of Settlement Alone)
CREATE TABLE IF NOT EXISTS notification_events (
  id VARCHAR(36) PRIMARY KEY,
  device_id VARCHAR(36) NOT NULL,
  merchant_id VARCHAR(36) NULL,
  package_name VARCHAR(160) NOT NULL,
  provider ENUM('BKASH', 'NAGAD', 'ROCKET', 'UNKNOWN') NOT NULL,
  event_uid VARCHAR(128) NOT NULL,
  event_hash CHAR(64) NOT NULL UNIQUE,
  raw_title VARCHAR(255) NULL,
  raw_body_redacted TEXT NOT NULL,
  parsed_amount_bdt DECIMAL(12, 2) NULL,
  parsed_trx_id VARCHAR(64) NULL,
  parsed_sender_phone VARCHAR(24) NULL,
  parsed_receiver_phone VARCHAR(24) NULL,
  parsed_balance_bdt DECIMAL(14, 2) NULL,
  parsed_tx_type VARCHAR(64) NULL,
  parser_confidence INT NOT NULL DEFAULT 0,
  parse_status ENUM('PARSED', 'UNPARSED', 'DUPLICATE', 'IGNORED_SECURITY') NOT NULL,
  duplicate_of_event_id VARCHAR(36) NULL,
  candidate_payment_id VARCHAR(36) NULL,
  device_timestamp_ms BIGINT NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ne_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_ne_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  INDEX idx_ne_trx (provider, parsed_trx_id),
  INDEX idx_ne_parse_status (parse_status),
  INDEX idx_ne_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Payment Match Candidates (Weighted Scoring & Ambiguity Resolution)
CREATE TABLE IF NOT EXISTS payment_match_candidates (
  id VARCHAR(36) PRIMARY KEY,
  payment_intent_id VARCHAR(36) NOT NULL,
  notification_event_id VARCHAR(36) NOT NULL,
  confidence_score INT NOT NULL,
  match_reasons_json JSON NOT NULL,
  status ENUM('PROPOSED', 'SELECTED', 'DISMISSED') NOT NULL DEFAULT 'PROPOSED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pmc_pi FOREIGN KEY (payment_intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmc_ne FOREIGN KEY (notification_event_id) REFERENCES notification_events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_pmc_pair (payment_intent_id, notification_event_id),
  INDEX idx_pmc_pi_status (payment_intent_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Authoritative Provider or Documented Manual Verifications (Required Before VERIFIED_SETTLED)
CREATE TABLE IF NOT EXISTS provider_verifications (
  id VARCHAR(36) PRIMARY KEY,
  payment_intent_id VARCHAR(36) NOT NULL,
  verification_source ENUM('PROVIDER_API', 'MANUAL_FINANCE_VERIFICATION') NOT NULL,
  provider ENUM('BKASH', 'NAGAD', 'ROCKET') NOT NULL,
  provider_trx_id VARCHAR(64) NOT NULL,
  verified_amount_bdt DECIMAL(12, 2) NOT NULL,
  documentary_evidence_ref VARCHAR(255) NOT NULL,
  provider_reference_payload_json JSON NULL,
  verifier_user_id VARCHAR(36) NULL,
  notes TEXT NULL,
  decision ENUM('VERIFIED', 'REJECTED') NOT NULL,
  verified_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pv_pi FOREIGN KEY (payment_intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE,
  CONSTRAINT fk_pv_user FOREIGN KEY (verifier_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_pv_provider_trx_verified (provider, provider_trx_id, decision),
  INDEX idx_pv_payment (payment_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Signed Merchant Webhook Deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  payment_intent_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  target_url VARCHAR(500) NOT NULL,
  payload_json JSON NOT NULL,
  signature_header VARCHAR(255) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  http_status INT NULL,
  response_body TEXT NULL,
  status ENUM('PENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
  next_retry_at DATETIME(3) NULL,
  last_attempt_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_wd_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  CONSTRAINT fk_wd_pi FOREIGN KEY (payment_intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE,
  INDEX idx_wd_status_retry (status, next_retry_at),
  INDEX idx_wd_merchant (merchant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Immutable Security & Financial Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  actor_type ENUM('USER', 'MERCHANT_API', 'DEVICE', 'SYSTEM') NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  actor_email VARCHAR(190) NULL,
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(80) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  before_state_json JSON NULL,
  after_state_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_action (action, created_at),
  INDEX idx_audit_resource (resource_type, resource_id),
  INDEX idx_audit_actor (actor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
