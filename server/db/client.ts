import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.ts';
import { encryptSecret, generateApiKey, generateSecretHex, newId, sha256Hex } from '../utils/crypto.ts';

export type SqlParam = string | number | boolean | null;

export interface DbAdapter {
  dialect: 'mysql' | 'sqlite';
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  execute(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  withTransaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>;
}

const SQLITE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    business_type TEXT NOT NULL DEFAULT 'ECOMMERCE',
    contact_email TEXT NOT NULL,
    webhook_url TEXT NULL,
    webhook_secret_enc TEXT NULL,
    api_key_prefix TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    allowed_ips_json TEXT NULL,
    settlement_mode TEXT NOT NULL DEFAULT 'PROVIDER_API_OR_MANUAL',
    fee_percent REAL NOT NULL DEFAULT 1.50,
    settled_balance_bdt REAL NOT NULL DEFAULT 0.00,
    pending_balance_bdt REAL NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS merchant_websites (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    site_name TEXT NOT NULL,
    domain TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'CUSTOM',
    callback_url TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(merchant_id, domain)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    merchant_id TEXT NULL REFERENCES merchants(id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS providers_config (
    provider_code TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    supports_personal INTEGER NOT NULL DEFAULT 1,
    supports_merchant INTEGER NOT NULL DEFAULT 1,
    supports_api_verification INTEGER NOT NULL DEFAULT 0,
    bangla_qr_reliable INTEGER NOT NULL DEFAULT 0,
    reliability_notes TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bank_sms_templates (
    id TEXT PRIMARY KEY,
    bank_name TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    provider_code TEXT NOT NULL DEFAULT 'BANK_SMS',
    sample_sms TEXT NOT NULL,
    amount_regex TEXT NOT NULL,
    trx_regex TEXT NOT NULL,
    account_regex TEXT NULL,
    bangla_qr_capable INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mfs_wallets (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'MERCHANT',
    account_title TEXT NOT NULL,
    bank_name TEXT NULL,
    bangla_qr_payload TEXT NULL,
    daily_limit_bdt REAL NOT NULL DEFAULT 250000.00,
    daily_received_bdt REAL NOT NULL DEFAULT 0.00,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(provider, account_number)
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NULL REFERENCES merchants(id) ON DELETE SET NULL,
    device_uid TEXT NULL UNIQUE,
    device_name TEXT NOT NULL,
    android_model TEXT NULL,
    android_version TEXT NULL,
    app_version TEXT NULL,
    sim_slots_json TEXT NULL,
    pairing_code TEXT NULL UNIQUE,
    pairing_expires_at TEXT NULL,
    device_token_hash TEXT NULL UNIQUE,
    hmac_secret_enc TEXT NULL,
    assigned_providers_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_PAIRING',
    last_heartbeat_at TEXT NULL,
    battery_pct INTEGER NULL,
    network_type TEXT NULL,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS device_wallets (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    wallet_id TEXT NOT NULL REFERENCES mfs_wallets(id) ON DELETE CASCADE,
    sim_slot INTEGER NULL,
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (device_id, wallet_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    website_id TEXT NULL REFERENCES merchant_websites(id) ON DELETE SET NULL,
    wallet_id TEXT NULL REFERENCES mfs_wallets(id) ON DELETE SET NULL,
    merchant_order_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_mode TEXT NOT NULL DEFAULT 'MERCHANT',
    amount_bdt REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BDT',
    customer_name TEXT NULL,
    customer_phone TEXT NULL,
    customer_email TEXT NULL,
    reference_code TEXT NOT NULL,
    bangla_qr_string TEXT NULL,
    submitted_trx_id TEXT NULL,
    submitted_sender_phone TEXT NULL,
    submitted_at TEXT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    match_confidence INTEGER NULL,
    matched_notification_id TEXT NULL,
    fraud_flags_json TEXT NULL,
    metadata_json TEXT NULL,
    detected_at TEXT NULL,
    matched_at TEXT NULL,
    verified_at TEXT NULL,
    settled_at TEXT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(merchant_id, merchant_order_id),
    UNIQUE(merchant_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    merchant_id TEXT NULL REFERENCES merchants(id) ON DELETE SET NULL,
    source_channel TEXT NOT NULL DEFAULT 'NOTIFICATION',
    sim_slot INTEGER NULL,
    package_name TEXT NOT NULL,
    sender_header TEXT NULL,
    provider TEXT NOT NULL,
    event_uid TEXT NOT NULL,
    event_hash TEXT NOT NULL UNIQUE,
    raw_title TEXT NULL,
    raw_body_redacted TEXT NOT NULL,
    parsed_amount_bdt REAL NULL,
    parsed_trx_id TEXT NULL,
    parsed_sender_phone TEXT NULL,
    parsed_receiver_account TEXT NULL,
    parsed_balance_bdt REAL NULL,
    parsed_tx_type TEXT NULL,
    parsed_bank_name TEXT NULL,
    parsed_transaction_time TEXT NULL,
    parser_module TEXT NULL,
    parser_confidence INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL,
    duplicate_of_event_id TEXT NULL,
    candidate_payment_id TEXT NULL,
    device_timestamp_ms INTEGER NOT NULL,
    received_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payment_match_candidates (
    id TEXT PRIMARY KEY,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
    notification_event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    confidence_score INTEGER NOT NULL,
    match_reasons_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PROPOSED',
    created_at TEXT NOT NULL,
    UNIQUE(payment_intent_id, notification_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS provider_verifications (
    id TEXT PRIMARY KEY,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
    verification_source TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_trx_id TEXT NOT NULL,
    verified_amount_bdt REAL NOT NULL,
    documentary_evidence_ref TEXT NOT NULL,
    provider_reference_payload_json TEXT NULL,
    verifier_user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT NULL,
    decision TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    UNIQUE(provider, provider_trx_id, decision)
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    target_url TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    signature_header TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER NULL,
    response_body TEXT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    next_retry_at TEXT NULL,
    last_attempt_at TEXT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fraud_alerts (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NULL,
    payment_intent_id TEXT NULL,
    device_id TEXT NULL,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    summary TEXT NOT NULL,
    details_json TEXT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_usage_logs (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_email TEXT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    ip_address TEXT NULL,
    user_agent TEXT NULL,
    before_state_json TEXT NULL,
    after_state_json TEXT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pi_status ON payment_intents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_pi_provider_amount ON payment_intents(provider, amount_bdt, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pi_submitted_trx ON payment_intents(submitted_trx_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ne_trx ON notification_events(provider, parsed_trx_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`,
];

const SAFE_SQLITE_MIGRATIONS = [
  "ALTER TABLE merchants ADD COLUMN fee_percent REAL NOT NULL DEFAULT 1.50",
  "ALTER TABLE merchants ADD COLUMN settled_balance_bdt REAL NOT NULL DEFAULT 0.00",
  "ALTER TABLE merchants ADD COLUMN pending_balance_bdt REAL NOT NULL DEFAULT 0.00",
  "ALTER TABLE mfs_wallets ADD COLUMN bank_name TEXT NULL",
  "ALTER TABLE mfs_wallets ADD COLUMN bangla_qr_payload TEXT NULL",
  "ALTER TABLE devices ADD COLUMN sim_slots_json TEXT NULL",
  "ALTER TABLE device_wallets ADD COLUMN sim_slot INTEGER NULL",
  "ALTER TABLE payment_intents ADD COLUMN website_id TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN account_mode TEXT NOT NULL DEFAULT 'MERCHANT'",
  "ALTER TABLE payment_intents ADD COLUMN bangla_qr_string TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN fraud_flags_json TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN detected_at TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN matched_at TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN verified_at TEXT NULL",
  "ALTER TABLE payment_intents ADD COLUMN settled_at TEXT NULL",
  "ALTER TABLE notification_events ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'NOTIFICATION'",
  "ALTER TABLE notification_events ADD COLUMN sim_slot INTEGER NULL",
  "ALTER TABLE notification_events ADD COLUMN sender_header TEXT NULL",
  "ALTER TABLE notification_events ADD COLUMN parsed_receiver_account TEXT NULL",
  "ALTER TABLE notification_events ADD COLUMN parsed_bank_name TEXT NULL",
  "ALTER TABLE notification_events ADD COLUMN parsed_transaction_time TEXT NULL",
  "ALTER TABLE notification_events ADD COLUMN parser_module TEXT NULL",
  // Migrate legacy status labels from v1 seed if present
  "UPDATE payment_intents SET status = 'PENDING' WHERE status = 'CREATED'",
  "UPDATE payment_intents SET status = 'DETECTED' WHERE status = 'CUSTOMER_SUBMITTED'",
  "UPDATE payment_intents SET status = 'MATCHED' WHERE status = 'CANDIDATE_MATCHED'",
  "UPDATE payment_intents SET status = 'REVIEW_REQUIRED' WHERE status = 'MANUAL_REVIEW_REQUIRED'",
  "UPDATE payment_intents SET status = 'SUCCESS' WHERE status = 'VERIFIED_SETTLED'",
  "UPDATE payment_intents SET status = 'FAILED' WHERE status = 'REJECTED'",
];

function normalizeParams(params: SqlParam[] = []): (string | number | null)[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

function createSqliteAdapter(dbFilePath: string): DbAdapter {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new DatabaseSync(dbFilePath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  for (const stmt of SQLITE_SCHEMA_STATEMENTS) {
    sqlite.exec(stmt);
  }
  for (const mig of SAFE_SQLITE_MIGRATIONS) {
    try {
      sqlite.exec(mig);
    } catch {
      // Ignore already-applied column migrations
    }
  }

  const adapter: DbAdapter = {
    dialect: 'sqlite',
    async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const prepared = sqlite.prepare(sql);
      return prepared.all(...normalizeParams(params)) as unknown as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
      const prepared = sqlite.prepare(sql);
      const row = prepared.get(...normalizeParams(params));
      return (row as unknown as T) ?? null;
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
      const prepared = sqlite.prepare(sql);
      const res = prepared.run(...normalizeParams(params));
      return { changes: Number(res.changes ?? 0) };
    },
    async withTransaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(adapter);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };

  return adapter;
}

function createMysqlAdapter(): DbAdapter {
  const pool = mysql.createPool({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    waitForConnections: true,
    connectionLimit: 15,
    ssl: env.mysql.ssl ? { rejectUnauthorized: true } : undefined,
    dateStrings: true,
  });

  function makeConnAdapter(conn: mysql.Pool | mysql.PoolConnection): DbAdapter {
    return {
      dialect: 'mysql',
      async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
        const [rows] = await conn.query(sql, normalizeParams(params));
        return rows as T[];
      },
      async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
        const [rows] = await conn.query(sql, normalizeParams(params));
        const arr = rows as T[];
        return arr[0] ?? null;
      },
      async execute(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
        const [result] = await conn.execute(sql, normalizeParams(params));
        const ok = result as mysql.ResultSetHeader;
        return { changes: ok.affectedRows ?? 0 };
      },
      async withTransaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
        const txConn = await pool.getConnection();
        await txConn.beginTransaction();
        try {
          const result = await fn(makeConnAdapter(txConn));
          await txConn.commit();
          return result;
        } catch (err) {
          await txConn.rollback();
          throw err;
        } finally {
          txConn.release();
        }
      },
    };
  }

  return makeConnAdapter(pool);
}

let cachedDb: DbAdapter | null = null;

export function getDb(): DbAdapter {
  if (cachedDb) return cachedDb;
  if (env.mysql.host) {
    cachedDb = createMysqlAdapter();
  } else {
    const dbPath = path.resolve(process.cwd(), 'data', 'gateway.db');
    cachedDb = createSqliteAdapter(dbPath);
  }
  return cachedDb;
}

export function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 23).replace('T', ' ');
}

export async function ensureSeedData(): Promise<void> {
  const db = getDb();
  const now = isoNow();

  // Seed Provider Capabilities Matrix (idempotent)
  const existingProviders = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM providers_config');
  if (!existingProviders || Number(existingProviders.cnt) === 0) {
    const providers = [
      ['BKASH', 'bKash (Personal & Merchant)', 1, 1, 1, 1, 'Tokenized Checkout API available for Merchant accounts; Personal SMS/Push requires finance or portal verification. Supports Bangla QR credits on Merchant wallets.', 1, now],
      ['NAGAD', 'Nagad (Personal & Merchant)', 1, 1, 1, 1, 'Nagad Merchant DFS Verify API available for Merchant accounts; Personal Send Money alerts use notification matching + manual confirmation.', 1, now],
      ['ROCKET', 'DBBL Rocket (Personal & Merchant)', 1, 1, 1, 1, '11-12 digit Rocket A/C numbers; SMS from 16216 & DBBL Rocket app notifications reliably expose TxnId, amount, and sender.', 1, now],
      ['UPAY', 'Upay (Personal & Merchant)', 1, 1, 0, 1, 'UCB Upay SMS & App alerts expose TrxID, amount, and sender MSISDN. Merchant portal or bank settlement verification recommended before SUCCESS.', 1, now],
      ['CELLFIN', 'Islami Bank CellFin', 1, 1, 0, 1, 'IBBL CellFin app push & SMS alerts provide TrxID, masked account, and amount; Bangla QR credits routed via IBBL merchant A/C are reliably parsed.', 1, now],
      ['BANGLA_QR', 'Bangla QR (EMVCo Interoperable)', 0, 1, 0, 1, 'Interoperable QR standard (Bangladesh Bank). Reliable matching requires receiving Bank/MFS SMS/push containing exact amount + terminal/merchant credit ref. City Bank, BRAC, DBBL, EBL & IBBL supported.', 1, now],
      ['BANK_SMS', 'Bank Account SMS Notification', 1, 1, 0, 1, 'Extensible regex template engine for BRAC, City Bank, DBBL, EBL, Prime, Pubali & Sonali Bank credit alerts. Always verify against bank statement before settlement.', 1, now],
    ];
    for (const p of providers) {
      await db.execute(
        `INSERT INTO providers_config (provider_code, display_name, supports_personal, supports_merchant, supports_api_verification, bangla_qr_reliable, reliability_notes, is_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p,
      );
    }
  }

  // Seed Bank SMS Templates (idempotent)
  const existingTemplates = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM bank_sms_templates');
  if (!existingTemplates || Number(existingTemplates.cnt) === 0) {
    const templates = [
      [
        newId(),
        'City Bank (Citytouch / Bangla QR)',
        'CITYBANK',
        'BANGLA_QR',
        'City Bank: Your A/C ***8841 credited by BDT 3,500.00 via BanglaQR from 01711223344. Ref: CBQR901288. Bal: BDT 145,200.00',
        '(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
        '(?:Ref|TrxID|TxnID)\\s*[:#-]?\\s*([A-Z0-9]{6,18})',
        'A\\/C\\s*([\\*\\d]{4,16})',
        1,
        1,
        now,
      ],
      [
        newId(),
        'BRAC Bank (Astha / Bangla QR)',
        'BRACBANK',
        'BANK_SMS',
        'BRAC Bank Alert: A/C 1501***902 credited with Tk 4,200.00 on 17-Nov-26. Desc: NPSB/QR-BRAC99201. Avl Bal Tk 92,100.00',
        '(?:Tk|BDT)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
        '(?:Desc|Ref|TrxID)\\s*[:#-]?\\s*(?:NPSB\\/)?([A-Z0-9-]{6,20})',
        'A\\/C\\s*([\\*\\d]{4,16})',
        1,
        1,
        now,
      ],
      [
        newId(),
        'Dutch-Bangla Bank (DBBL / NexusPay)',
        'DBBL',
        'BANK_SMS',
        'DBBL: Tk 2,850.00 credited to A/C 101***4412 by NexusPay/BanglaQR. TxnId: DBBL774102. Bal: Tk 64,000.00',
        '(?:Tk|BDT)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
        '(?:TxnId|TrxID|Ref)\\s*[:#-]?\\s*([A-Z0-9]{6,18})',
        'A\\/C\\s*([\\*\\d]{4,16})',
        1,
        1,
        now,
      ],
      [
        newId(),
        'Islami Bank Bangladesh (CellFin / iBanking)',
        'IBBL',
        'CELLFIN',
        'IBBL CellFin: Your A/C 2050***318 credited BDT 1,950.00 via CellFin QR. TrxID: CFN4488210. Bal BDT 51,400.00',
        '(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
        '(?:TrxID|TxnID|Ref)\\s*[:#-]?\\s*([A-Z0-9]{6,18})',
        'A\\/C\\s*([\\*\\d]{4,16})',
        1,
        1,
        now,
      ],
      [
        newId(),
        'Eastern Bank PLC (EBL Skybanking)',
        'EBL',
        'BANK_SMS',
        'EBL Alert: BDT 5,000.00 deposited/credited to A/C ***2219. Ref: EBL559012. Available Balance BDT 118,500.00',
        '(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
        '(?:Ref|TrxID|TxnID)\\s*[:#-]?\\s*([A-Z0-9]{6,18})',
        'A\\/C\\s*([\\*\\d]{4,16})',
        1,
        1,
        now,
      ],
    ];
    for (const t of templates) {
      await db.execute(
        `INSERT INTO bank_sms_templates (id, bank_name, sender_id, provider_code, sample_sms, amount_regex, trx_regex, account_regex, bangla_qr_capable, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t,
      );
    }
  }

  const existingUsers = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM users');
  if (existingUsers && Number(existingUsers.cnt) > 0) {
    // Ensure new demo wallets/websites exist if upgraded from v1 DB
    const m1 = await db.queryOne<{ id: string }>('SELECT id FROM merchants LIMIT 1');
    if (m1) {
      const sites = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM merchant_websites');
      if (!sites || Number(sites.cnt) === 0) {
        await db.execute(
          `INSERT INTO merchant_websites (id, merchant_id, site_name, domain, platform, callback_url, is_active, created_at)
           VALUES (?, ?, 'DeshiCart Main Store', 'shop.deshicart.com.bd', 'WOOCOMMERCE', 'https://shop.deshicart.com.bd/wp-json/takaledger/v1/webhook', 1, ?)`,
          [newId(), m1.id, now],
        );
      }
    }
    return;
  }

  const initialPassword = env.bootstrapAdminPassword || generateSecretHex(12);

  if (!env.bootstrapAdminPassword && !env.isProduction) {
    console.info(
      `[TakaLedger] Bootstrap admin ${env.bootstrapAdminEmail} created for dev sandbox. Use Quick Dev Sign-In or set BOOTSTRAP_ADMIN_PASSWORD in .env.`,
    );
  }

  const adminHash = await bcrypt.hash(initialPassword, 10);
  const reviewerHash = await bcrypt.hash(generateSecretHex(16), 10);
  const merchantUserHash = await bcrypt.hash(generateSecretHex(16), 10);

  const m1Id = newId();
  const m2Id = newId();
  const m1Key = generateApiKey('tl_live');
  const m2Key = generateApiKey('tl_live');
  const m1WebhookSecret = encryptSecret(generateSecretHex(24));
  const m2WebhookSecret = encryptSecret(generateSecretHex(24));

  await db.execute(
    `INSERT INTO merchants (id, name, slug, business_type, contact_email, webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, allowed_ips_json, settlement_mode, fee_percent, settled_balance_bdt, pending_balance_bdt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m1Id,
      'DeshiCart Electronics BD',
      'deshicart-bd',
      'RETAIL_ECOMMERCE',
      'finance@deshicart.com.bd',
      `${env.appUrl}/api/demo-merchant-webhook`,
      m1WebhookSecret,
      m1Key.prefix,
      m1Key.hash,
      JSON.stringify(['0.0.0.0/0']),
      'PROVIDER_API_OR_MANUAL',
      1.5,
      4800.0,
      4000.0,
      'ACTIVE',
      now,
      now,
    ],
  );

  await db.execute(
    `INSERT INTO merchants (id, name, slug, business_type, contact_email, webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, allowed_ips_json, settlement_mode, fee_percent, settled_balance_bdt, pending_balance_bdt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m2Id,
      'Padma SaaS & Cloud',
      'padma-cloud',
      'SAAS_SUBSCRIPTION',
      'billing@padmacloud.bd',
      `${env.appUrl}/api/demo-merchant-webhook`,
      m2WebhookSecret,
      m2Key.prefix,
      m2Key.hash,
      JSON.stringify(['0.0.0.0/0']),
      'PROVIDER_API_OR_MANUAL',
      1.25,
      0.0,
      6500.0,
      'ACTIVE',
      now,
      now,
    ],
  );

  // Websites
  const wSite1 = newId();
  const wSite2 = newId();
  await db.execute(
    `INSERT INTO merchant_websites (id, merchant_id, site_name, domain, platform, callback_url, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [wSite1, m1Id, 'DeshiCart WooCommerce Store', 'shop.deshicart.com.bd', 'WOOCOMMERCE', `${env.appUrl}/api/demo-merchant-webhook`, now],
  );
  await db.execute(
    `INSERT INTO merchant_websites (id, merchant_id, site_name, domain, platform, callback_url, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [wSite2, m2Id, 'Padma Cloud Billing Portal', 'billing.padmacloud.bd', 'CUSTOM', `${env.appUrl}/api/demo-merchant-webhook`, now],
  );

  const adminId = newId();
  const reviewerId = newId();
  const merchantAdminId = newId();

  await db.execute(
    `INSERT INTO users (id, email, full_name, password_hash, role, merchant_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [adminId, env.bootstrapAdminEmail, 'Farhan Rahman', adminHash, 'SUPER_ADMIN', null, 1, now, now],
  );
  await db.execute(
    `INSERT INTO users (id, email, full_name, password_hash, role, merchant_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reviewerId, 'finance@takaledger.bd', 'Nusrat Jahan', reviewerHash, 'FINANCE_REVIEWER', null, 1, now, now],
  );
  await db.execute(
    `INSERT INTO users (id, email, full_name, password_hash, role, merchant_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [merchantAdminId, 'ops@deshicart.com.bd', 'Tanvir Ahmed', merchantUserHash, 'MERCHANT_ADMIN', m1Id, 1, now, now],
  );

  // MFS & Bank Wallets
  const wBkash1 = newId();
  const wNagad1 = newId();
  const wRocket1 = newId();
  const wUpay1 = newId();
  const wCellfin1 = newId();
  const wBanglaQr1 = newId();
  const wBkash2 = newId();

  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'BKASH', '01711002233', 'MERCHANT', 'DeshiCart bKash Merchant', 500000, 18450, 1, ?)`,
    [wBkash1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'NAGAD', '01819004455', 'MERCHANT', 'DeshiCart Nagad Merchant', 400000, 9200, 1, ?)`,
    [wNagad1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'ROCKET', '019120077889', 'PERSONAL', 'DeshiCart Rocket Counter', 300000, 4600, 1, ?)`,
    [wRocket1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'UPAY', '01722003344', 'MERCHANT', 'DeshiCart Upay Merchant', 250000, 1200, 1, ?)`,
    [wUpay1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, bank_name, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'CELLFIN', '205011223318', 'BANK_ACCOUNT', 'DeshiCart IBBL CellFin', 'Islami Bank Bangladesh PLC', 500000, 0, 1, ?)`,
    [wCellfin1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, bank_name, bangla_qr_payload, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'BANGLA_QR', '150199208841', 'MERCHANT', 'DeshiCart City Bank Bangla QR', 'The City Bank PLC', '00020101021126360014BD.COM.BANGLAQR01141501992088415204541153030505802BD5918DESHICART BD6005DHAKA', 1000000, 3500, 1, ?)`,
    [wBanglaQr1, m1Id, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, 'BKASH', '01614009911', 'PERSONAL', 'Padma Cloud bKash Desk', 250000, 6500, 1, ?)`,
    [wBkash2, m2Id, now],
  );

  // Paired Android Listener Devices (Multi-SIM)
  const dev1Id = newId();
  const dev2Id = newId();
  const dev3Id = newId();

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, sim_slots_json, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev1Id,
      m1Id,
      'AND-DHAKA-SIM01',
      'Dhaka Gulshan Dual-SIM Node #1',
      'Samsung Galaxy A15',
      'Android 14',
      '2.0.0',
      JSON.stringify([{ slot: 1, carrier: 'Grameenphone', number: '01711002233' }, { slot: 2, carrier: 'Robi', number: '01819004455' }]),
      sha256Hex(generateSecretHex(24)),
      encryptSecret(generateSecretHex(24)),
      JSON.stringify(['BKASH', 'NAGAD', 'UPAY', 'BANGLA_QR']),
      'ACTIVE',
      isoNow(-35_000),
      89,
      '4G LTE',
      0,
      isoNow(-86400_000 * 5),
      now,
    ],
  );

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, sim_slots_json, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev2Id,
      m1Id,
      'AND-DHAKA-SIM02',
      'Chattogram Failover Node #2',
      'Xiaomi Redmi 13C',
      'Android 14',
      '2.0.0',
      JSON.stringify([{ slot: 1, carrier: 'Banglalink', number: '01912007788' }]),
      sha256Hex(generateSecretHex(24)),
      encryptSecret(generateSecretHex(24)),
      JSON.stringify(['ROCKET', 'CELLFIN', 'BANK_SMS']),
      'ACTIVE',
      isoNow(-90_000),
      74,
      'Wi-Fi',
      1,
      isoNow(-86400_000 * 3),
      now,
    ],
  );

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, sim_slots_json, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev3Id,
      m2Id,
      'AND-PADMA-01',
      'Padma Cloud Listener #1',
      'Pixel 6a',
      'Android 15',
      '2.0.0',
      JSON.stringify([{ slot: 1, carrier: 'Airtel', number: '01614009911' }]),
      sha256Hex(generateSecretHex(24)),
      encryptSecret(generateSecretHex(24)),
      JSON.stringify(['BKASH']),
      'ACTIVE',
      isoNow(-25_000),
      94,
      'Wi-Fi',
      0,
      isoNow(-86400_000 * 2),
      now,
    ],
  );

  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, sim_slot, assigned_at) VALUES (?, ?, 1, ?)', [dev1Id, wBkash1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, sim_slot, assigned_at) VALUES (?, ?, 2, ?)', [dev1Id, wNagad1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, sim_slot, assigned_at) VALUES (?, ?, 1, ?)', [dev2Id, wRocket1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, sim_slot, assigned_at) VALUES (?, ?, 1, ?)', [dev2Id, wCellfin1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, sim_slot, assigned_at) VALUES (?, ?, 1, ?)', [dev3Id, wBkash2, now]);

  // Seed Payment Intents across the 8 lifecycle states
  const p1Id = newId(); // MATCHED (awaiting verification)
  const p2Id = newId(); // SUCCESS (verified & settled)
  const p3Id = newId(); // DETECTED (customer submitted)
  const p4Id = newId(); // REVIEW_REQUIRED (amount mismatch)
  const p5Id = newId(); // PENDING (ready for checkout testing)
  const p6Id = newId(); // MATCHED (Bangla QR awaiting verification)

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, detected_at, matched_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BKASH', 'MERCHANT', 2450.00, 'BDT', 'Mahmudul Hasan', '01755112233', 'mahmud@example.bd', 'DC98412', 'BKH9X4M21Q', '01755112233', ?, ?, ?, 'MATCHED', 95, ?, ?, ?)`,
    [p1Id, m1Id, wSite1, wBkash1, 'DC-ORD-98412', 'idem-dc-98412', isoNow(-300_000), isoNow(-300_000), isoNow(-180_000), isoNow(1800_000), isoNow(-420_000), isoNow(-180_000)],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, detected_at, matched_at, verified_at, settled_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'NAGAD', 'MERCHANT', 4800.00, 'BDT', 'Sadia Islam', '01812334455', 'sadia@example.bd', 'DC98409', '71NGD8842K', '01812334455', ?, ?, ?, ?, ?, 'SUCCESS', 100, ?, ?, ?)`,
    [p2Id, m1Id, wSite1, wNagad1, 'DC-ORD-98409', 'idem-dc-98409', isoNow(-3600_000), isoNow(-3600_000), isoNow(-3480_000), isoNow(-3300_000), isoNow(-3300_000), isoNow(-1800_000), isoNow(-4200_000), isoNow(-3300_000)],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, detected_at, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BKASH', 'PERSONAL', 6500.00, 'BDT', 'Arifur Rahman', '01922445566', 'arif@company.bd', 'PC2041', 'BKH4T7P11N', '01922445566', ?, ?, 'DETECTED', ?, ?, ?)`,
    [p3Id, m2Id, wSite2, wBkash2, 'PC-INV-2041', 'idem-pc-2041', isoNow(-120_000), isoNow(-120_000), isoNow(1800_000), isoNow(-240_000), isoNow(-120_000)],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, detected_at, status, match_confidence, fraud_flags_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ROCKET', 'PERSONAL', 1550.00, 'BDT', 'Karim Uddin', '01688990011', 'karim@example.bd', 'DC98410', 'RKT99201122', '01688990011', ?, ?, 'REVIEW_REQUIRED', 55, ?, ?, ?, ?)`,
    [p4Id, m1Id, wSite1, wRocket1, 'DC-ORD-98410', 'idem-dc-98410', isoNow(-900_000), isoNow(-900_000), JSON.stringify(['AMOUNT_SHORT_50_BDT']), isoNow(1200_000), isoNow(-1100_000), isoNow(-600_000)],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BKASH', 'MERCHANT', 1250.00, 'BDT', 'Tasnim Chowdhury', '01711889900', 'tasnim@example.bd', 'DC98425', 'PENDING', ?, ?, ?)`,
    [p5Id, m1Id, wSite1, wBkash1, 'DC-ORD-98425', 'idem-dc-98425', isoNow(2700_000), isoNow(-60_000), isoNow(-60_000)],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, website_id, wallet_id, merchant_order_id, idempotency_key, provider, account_mode, amount_bdt, currency, customer_name, customer_phone, reference_code, bangla_qr_string, submitted_trx_id, submitted_sender_phone, submitted_at, detected_at, matched_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BANGLA_QR', 'MERCHANT', 3500.00, 'BDT', 'Nafisa Akter', '01711223344', 'DCQR8841', '00020101021226360014BD.COM.BANGLAQR011415019920884152045411530305054073500.005802BD5918DESHICART BD6005DHAKA62120508DCQR8841', 'CBQR901288', '01711223344', ?, ?, ?, 'MATCHED', 92, ?, ?, ?)`,
    [p6Id, m1Id, wSite1, wBanglaQr1, 'DC-ORD-98420', 'idem-dc-98420', isoNow(-220_000), isoNow(-220_000), isoNow(-150_000), isoNow(1800_000), isoNow(-300_000), isoNow(-150_000)],
  );

  // Notification Events
  const n1Id = newId();
  const n2Id = newId();
  const n3Id = newId();
  const n4Id = newId();

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt, parsed_tx_type, parser_module, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, 'NOTIFICATION', 1, 'com.bKash.customerapp', 'bKash', 'BKASH', 'evt-bkh-9x4m21q', ?, 'bKash Payment Received', 'You have received payment Tk 2,450.00 from 01755112233. Fee Tk 0.00. Balance Tk 42,150.00. TrxID BKH9X4M21Q.', 2450.00, 'BKH9X4M21Q', '01755112233', '01711002233', 42150.00, 'PAYMENT', 'bkashParser', 98, 'PARSED', ?, ?, ?)`,
    [n1Id, dev1Id, m1Id, sha256Hex('BKASH|BKH9X4M21Q|2450.00'), p1Id, Date.now() - 190_000, isoNow(-180_000)],
  );

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt, parsed_tx_type, parser_module, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, 'NOTIFICATION', 2, 'com.konasl.nagad', 'Nagad', 'NAGAD', 'evt-ngd-71ngd8842k', ?, 'Nagad Money Received', 'Money Received. Amount: Tk 4800.00 Sender: 01812334455 Ref: DC98409. TxnID: 71NGD8842K. Balance: Tk 29,400.00', 4800.00, '71NGD8842K', '01812334455', '01819004455', 29400.00, 'MONEY_RECEIVED', 'nagadParser', 99, 'PARSED', ?, ?, ?)`,
    [n2Id, dev1Id, m1Id, sha256Hex('NAGAD|71NGD8842K|4800.00'), p2Id, Date.now() - 3500_000, isoNow(-3480_000)],
  );

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt, parsed_tx_type, parser_module, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, 'SMS', 1, 'com.google.android.apps.messaging', '16216', 'ROCKET', 'evt-rkt-99201122', ?, 'DBBL Rocket Alert', 'Tk1,500.00 received from A/C 01688990011 Fee: Tk0.00 TxnId: RKT99201122. Balance: Tk18,900.00', 1500.00, 'RKT99201122', '01688990011', '019120077889', 18900.00, 'CASH_IN', 'rocketParser', 92, 'PARSED', ?, ?, ?)`,
    [n3Id, dev2Id, m1Id, sha256Hex('ROCKET|RKT99201122|1500.00'), p4Id, Date.now() - 620_000, isoNow(-600_000)],
  );

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, source_channel, sim_slot, package_name, sender_header, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_account, parsed_balance_bdt, parsed_tx_type, parsed_bank_name, parser_module, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, 'SMS', 1, 'com.google.android.apps.messaging', 'CITYBANK', 'BANGLA_QR', 'evt-bqr-cbqr901288', ?, 'City Bank Bangla QR', 'City Bank: Your A/C ***8841 credited by BDT 3,500.00 via BanglaQR from 01711223344. Ref: CBQR901288. Bal: BDT 145,200.00', 3500.00, 'CBQR901288', '01711223344', '***8841', 145200.00, 'BANGLA_QR_CREDIT', 'The City Bank PLC', 'banglaQrParser', 95, 'PARSED', ?, ?, ?)`,
    [n4Id, dev1Id, m1Id, sha256Hex('BANGLA_QR|CBQR901288|3500.00'), p6Id, Date.now() - 160_000, isoNow(-150_000)],
  );

  await db.execute('UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?', [n1Id, p1Id]);
  await db.execute('UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?', [n2Id, p2Id]);
  await db.execute('UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?', [n3Id, p4Id]);
  await db.execute('UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?', [n4Id, p6Id]);

  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, 95, ?, 'PROPOSED', ?)`,
    [newId(), p1Id, n1Id, JSON.stringify(['PROVIDER_EXACT', 'AMOUNT_EXACT', 'TRX_ID_EXACT', 'SENDER_PHONE_MATCH']), isoNow(-180_000)],
  );
  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, 100, ?, 'SELECTED', ?)`,
    [newId(), p2Id, n2Id, JSON.stringify(['PROVIDER_EXACT', 'AMOUNT_EXACT', 'TRX_ID_EXACT', 'REFERENCE_MATCH']), isoNow(-3480_000)],
  );
  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, 55, ?, 'PROPOSED', ?)`,
    [newId(), p4Id, n3Id, JSON.stringify(['PROVIDER_EXACT', 'TRX_ID_EXACT', 'AMOUNT_MISMATCH_BDT_50_SHORT']), isoNow(-600_000)],
  );
  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, 92, ?, 'PROPOSED', ?)`,
    [newId(), p6Id, n4Id, JSON.stringify(['BANGLA_QR_EXACT', 'AMOUNT_EXACT', 'TRX_ID_EXACT', 'BANK_ACCOUNT_SUFFIX_MATCH']), isoNow(-150_000)],
  );

  // Authoritative Verification for p2Id (ONLY settled/SUCCESS payment)
  await db.execute(
    `INSERT INTO provider_verifications (id, payment_intent_id, verification_source, provider, provider_trx_id, verified_amount_bdt, documentary_evidence_ref, provider_reference_payload_json, verifier_user_id, notes, decision, verified_at)
     VALUES (?, ?, 'MANUAL_FINANCE_VERIFICATION', 'NAGAD', '71NGD8842K', 4800.00, 'NAGAD-MERCHANT-STMT-2026-11-17-4800', ?, ?, ?, 'VERIFIED', ?)`,
    [
      newId(),
      p2Id,
      JSON.stringify({ statementDate: '2026-11-17', portalRef: 'NGD-PORTAL-718842' }),
      reviewerId,
      'Cross-checked against Nagad Merchant Portal daily settlement statement.',
      isoNow(-3300_000),
    ],
  );

  // Fraud Alert sample for p4Id (Amount mismatch)
  await db.execute(
    `INSERT INTO fraud_alerts (id, merchant_id, payment_intent_id, device_id, alert_type, severity, summary, details_json, status, created_at)
     VALUES (?, ?, ?, ?, 'AMOUNT_MISMATCH', 'MEDIUM', 'Customer order expected ৳1,550.00 but Rocket SMS reported ৳1,500.00', ?, 'OPEN', ?)`,
    [newId(), m1Id, p4Id, dev2Id, JSON.stringify({ expectedBdt: 1550, receivedBdt: 1500, trxId: 'RKT99201122' }), isoNow(-600_000)],
  );

  // Sample API Usage Logs
  await db.execute(
    `INSERT INTO api_usage_logs (id, merchant_id, endpoint, method, status_code, latency_ms, created_at)
     VALUES (?, ?, '/api/v1/payments', 'POST', 201, 24, ?)`,
    [newId(), m1Id, isoNow(-420_000)],
  );
  await db.execute(
    `INSERT INTO api_usage_logs (id, merchant_id, endpoint, method, status_code, latency_ms, created_at)
     VALUES (?, ?, '/api/v1/payments/:id', 'GET', 200, 11, ?)`,
    [newId(), m1Id, isoNow(-300_000)],
  );

  // Webhook Delivery log for p2Id
  await db.execute(
    `INSERT INTO webhook_deliveries (id, merchant_id, payment_intent_id, event_type, target_url, payload_json, signature_header, attempt_count, http_status, response_body, status, last_attempt_at, created_at)
     VALUES (?, ?, ?, 'payment.verified_settled', ?, ?, 't=1763420000,v1=demo_signed_digest', 1, 200, '{"received":true}', 'DELIVERED', ?, ?)`,
    [
      newId(),
      m1Id,
      p2Id,
      `${env.appUrl}/api/demo-merchant-webhook`,
      JSON.stringify({
        event: 'payment.verified_settled',
        paymentId: p2Id,
        merchantOrderId: 'DC-ORD-98409',
        provider: 'NAGAD',
        amountBdt: 4800,
        status: 'SUCCESS',
        trxId: '71NGD8842K',
      }),
      isoNow(-3295_000),
      isoNow(-3300_000),
    ],
  );

  // Audit Logs
  await db.execute(
    `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, resource_type, resource_id, ip_address, after_state_json, created_at)
     VALUES (?, 'USER', ?, 'finance@takaledger.bd', 'PAYMENT_MANUALLY_VERIFIED_SETTLED', 'payment_intent', ?, '103.145.22.10', ?, ?)`,
    [
      newId(),
      reviewerId,
      p2Id,
      JSON.stringify({ status: 'SUCCESS', documentaryEvidenceRef: 'NAGAD-MERCHANT-STMT-2026-11-17-4800', providerTrxId: '71NGD8842K' }),
      isoNow(-3300_000),
    ],
  );

  await db.execute(
    `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, resource_type, resource_id, ip_address, after_state_json, created_at)
     VALUES (?, 'DEVICE', ?, 'AND-DHAKA-SIM01', 'NOTIFICATION_CANDIDATE_MATCHED', 'payment_intent', ?, '103.98.14.52', ?, ?)`,
    [
      newId(),
      dev1Id,
      p1Id,
      JSON.stringify({ status: 'MATCHED', confidence: 95, trxId: 'BKH9X4M21Q', note: 'Notification matched only; settlement pending verification.' }),
      isoNow(-180_000),
    ],
  );
}
