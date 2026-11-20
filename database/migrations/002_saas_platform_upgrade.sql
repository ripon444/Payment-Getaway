-- TakaLedger Commercial Multi-Merchant SaaS Platform Upgrade Migration (v2.0)
-- Additive, non-destructive MySQL 8.0+ migration. Preserves all existing data.

-- 1. Subscription Packages
CREATE TABLE IF NOT EXISTS subscription_packages (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  tagline VARCHAR(180) NULL,
  monthly_price_bdt DECIMAL(12, 2) NOT NULL,
  yearly_price_bdt DECIMAL(12, 2) NOT NULL,
  max_websites INT NOT NULL DEFAULT 1,
  max_devices INT NOT NULL DEFAULT 1,
  monthly_tx_limit INT NOT NULL DEFAULT 500,
  allowed_providers_json JSON NOT NULL,
  allow_personal_wallets TINYINT(1) NOT NULL DEFAULT 1,
  allow_auto_matching TINYINT(1) NOT NULL DEFAULT 1,
  allow_webhooks TINYINT(1) NOT NULL DEFAULT 1,
  allow_api_access TINYINT(1) NOT NULL DEFAULT 1,
  history_retention_days INT NOT NULL DEFAULT 90,
  support_level VARCHAR(64) NOT NULL DEFAULT 'STANDARD',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Merchant Subscriptions
CREATE TABLE IF NOT EXISTS merchant_subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  package_id VARCHAR(36) NOT NULL,
  billing_cycle ENUM('MONTHLY', 'YEARLY') NOT NULL DEFAULT 'MONTHLY',
  status ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'TRIAL',
  price_bdt DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  current_period_start DATETIME(3) NOT NULL,
  current_period_end DATETIME(3) NOT NULL,
  tx_used_current_period INT NOT NULL DEFAULT 0,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ms_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ms_package FOREIGN KEY (package_id) REFERENCES subscription_packages(id) ON DELETE RESTRICT,
  INDEX idx_ms_merchant_status (merchant_id, status),
  INDEX idx_ms_period_end (current_period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Subscription Revenue Invoices
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  subscription_id VARCHAR(36) NOT NULL,
  package_id VARCHAR(36) NOT NULL,
  invoice_number VARCHAR(40) NOT NULL UNIQUE,
  billing_cycle ENUM('MONTHLY', 'YEARLY') NOT NULL DEFAULT 'MONTHLY',
  amount_bdt DECIMAL(12, 2) NOT NULL,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'BKASH',
  status ENUM('PENDING', 'PAID', 'VOID') NOT NULL DEFAULT 'PAID',
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_si_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  CONSTRAINT fk_si_subscription FOREIGN KEY (subscription_id) REFERENCES merchant_subscriptions(id) ON DELETE CASCADE,
  INDEX idx_si_merchant (merchant_id, created_at),
  INDEX idx_si_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Additive Column Upgrades on Existing Tables
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS business_phone VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS business_address VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS api_secret_enc TEXT NULL,
  ADD COLUMN IF NOT EXISTS test_api_key_prefix VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS test_api_key_hash CHAR(64) NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS auto_verify_policy ENUM('STRICT_API_ONLY', 'DETERMINISTIC_PERSONAL_PROOF') NOT NULL DEFAULT 'DETERMINISTIC_PERSONAL_PROOF';

ALTER TABLE merchant_websites
  ADD COLUMN IF NOT EXISTS verification_token VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS verified_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS verification_status ENUM('PENDING', 'VERIFIED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS success_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS cancel_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS enabled_providers_json JSON NULL,
  ADD COLUMN IF NOT EXISTS mode ENUM('LIVE', 'TEST') NOT NULL DEFAULT 'LIVE';

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS mode ENUM('LIVE', 'TEST') NOT NULL DEFAULT 'LIVE',
  ADD COLUMN IF NOT EXISTS requested_amount_bdt DECIMAL(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS unique_paisa_offset DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS success_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS cancel_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS verification_method VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS auto_verified TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS unpaired_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(255) NULL;

ALTER TABLE provider_verifications
  MODIFY COLUMN verification_source ENUM('PROVIDER_API', 'MANUAL_FINANCE_VERIFICATION', 'DETERMINISTIC_PERSONAL_PROOF') NOT NULL;
