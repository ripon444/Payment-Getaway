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
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
  `CREATE TABLE IF NOT EXISTS mfs_wallets (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'MERCHANT',
    account_title TEXT NOT NULL,
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
    assigned_at TEXT NOT NULL,
    PRIMARY KEY (device_id, wallet_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    wallet_id TEXT NULL REFERENCES mfs_wallets(id) ON DELETE SET NULL,
    merchant_order_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    amount_bdt REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BDT',
    customer_name TEXT NULL,
    customer_phone TEXT NULL,
    customer_email TEXT NULL,
    reference_code TEXT NOT NULL,
    submitted_trx_id TEXT NULL,
    submitted_sender_phone TEXT NULL,
    submitted_at TEXT NULL,
    status TEXT NOT NULL DEFAULT 'CREATED',
    match_confidence INTEGER NULL,
    matched_notification_id TEXT NULL,
    metadata_json TEXT NULL,
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
    package_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    event_uid TEXT NOT NULL,
    event_hash TEXT NOT NULL UNIQUE,
    raw_title TEXT NULL,
    raw_body_redacted TEXT NOT NULL,
    parsed_amount_bdt REAL NULL,
    parsed_trx_id TEXT NULL,
    parsed_sender_phone TEXT NULL,
    parsed_receiver_phone TEXT NULL,
    parsed_balance_bdt REAL NULL,
    parsed_tx_type TEXT NULL,
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
  const existingUsers = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM users');
  if (existingUsers && Number(existingUsers.cnt) > 0) {
    return;
  }

  const now = isoNow();
  const initialPassword =
    env.bootstrapAdminPassword ||
    generateSecretHex(12);

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
    `INSERT INTO merchants (id, name, slug, business_type, contact_email, webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, allowed_ips_json, settlement_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      'ACTIVE',
      now,
      now,
    ],
  );

  await db.execute(
    `INSERT INTO merchants (id, name, slug, business_type, contact_email, webhook_url, webhook_secret_enc, api_key_prefix, api_key_hash, allowed_ips_json, settlement_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      'ACTIVE',
      now,
      now,
    ],
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

  // MFS Wallets
  const wBkash1 = newId();
  const wNagad1 = newId();
  const wRocket1 = newId();
  const wBkash2 = newId();

  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [wBkash1, m1Id, 'BKASH', '01711002233', 'MERCHANT', 'DeshiCart bKash Merchant', 500000, 18450, 1, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [wNagad1, m1Id, 'NAGAD', '01819004455', 'MERCHANT', 'DeshiCart Nagad Merchant', 400000, 9200, 1, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [wRocket1, m1Id, 'ROCKET', '019120077889', 'MERCHANT', 'DeshiCart Rocket DBBL', 300000, 4600, 1, now],
  );
  await db.execute(
    `INSERT INTO mfs_wallets (id, merchant_id, provider, account_number, account_type, account_title, daily_limit_bdt, daily_received_bdt, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [wBkash2, m2Id, 'BKASH', '01614009911', 'AGENT', 'Padma Cloud bKash Desk', 250000, 6500, 1, now],
  );

  // Paired Android Listener Devices
  const dev1Id = newId();
  const dev2Id = newId();
  const dev3Id = newId();

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev1Id,
      m1Id,
      'AND-DHAKA-SIM01',
      'Dhaka Gulshan Node #1',
      'Samsung Galaxy A15',
      'Android 14',
      '1.4.2',
      sha256Hex(generateSecretHex(24)),
      encryptSecret(generateSecretHex(24)),
      JSON.stringify(['BKASH', 'NAGAD']),
      'ACTIVE',
      isoNow(-45_000),
      88,
      '4G LTE',
      0,
      isoNow(-86400_000 * 5),
      now,
    ],
  );

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev2Id,
      m1Id,
      'AND-DHAKA-SIM02',
      'Chattogram Failover Node #2',
      'Xiaomi Redmi 13C',
      'Android 14',
      '1.4.2',
      sha256Hex(generateSecretHex(24)),
      encryptSecret(generateSecretHex(24)),
      JSON.stringify(['ROCKET', 'BKASH']),
      'ACTIVE',
      isoNow(-120_000),
      72,
      'Wi-Fi',
      1,
      isoNow(-86400_000 * 3),
      now,
    ],
  );

  await db.execute(
    `INSERT INTO devices (id, merchant_id, device_uid, device_name, android_model, android_version, app_version, device_token_hash, hmac_secret_enc, assigned_providers_json, status, last_heartbeat_at, battery_pct, network_type, queue_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev3Id,
      m2Id,
      'AND-PADMA-01',
      'Padma Cloud Listener #1',
      'Pixel 6a',
      'Android 15',
      '1.4.2',
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

  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)', [dev1Id, wBkash1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)', [dev1Id, wNagad1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)', [dev2Id, wRocket1, now]);
  await db.execute('INSERT INTO device_wallets (device_id, wallet_id, assigned_at) VALUES (?, ?, ?)', [dev3Id, wBkash2, now]);

  // Seed Payment Intents across realistic lifecycle stages
  const p1Id = newId(); // CANDIDATE_MATCHED (awaiting verification - NEVER auto settled!)
  const p2Id = newId(); // VERIFIED_SETTLED (with provider_verifications record)
  const p3Id = newId(); // CUSTOMER_SUBMITTED (awaiting notification)
  const p4Id = newId(); // MANUAL_REVIEW_REQUIRED (amount mismatch / duplicate check)
  const p5Id = newId(); // CREATED (ready for customer checkout testing)

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p1Id,
      m1Id,
      wBkash1,
      'DC-ORD-98412',
      'idem-dc-98412',
      'BKASH',
      2450.00,
      'Mahmudul Hasan',
      '01755112233',
      'mahmud@example.bd',
      'DC98412',
      'BKH9X4M21Q',
      '01755112233',
      isoNow(-300_000),
      'CANDIDATE_MATCHED',
      95,
      isoNow(1800_000),
      isoNow(-420_000),
      isoNow(-180_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p2Id,
      m1Id,
      wNagad1,
      'DC-ORD-98409',
      'idem-dc-98409',
      'NAGAD',
      4800.00,
      'Sadia Islam',
      '01812334455',
      'sadia@example.bd',
      'DC98409',
      '71NGD8842K',
      '01812334455',
      isoNow(-3600_000),
      'VERIFIED_SETTLED',
      100,
      isoNow(-1800_000),
      isoNow(-4200_000),
      isoNow(-3300_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p3Id,
      m2Id,
      wBkash2,
      'PC-INV-2041',
      'idem-pc-2041',
      'BKASH',
      6500.00,
      'Arifur Rahman',
      '01922445566',
      'arif@company.bd',
      'PC2041',
      'BKH4T7P11N',
      '01922445566',
      isoNow(-120_000),
      'CUSTOMER_SUBMITTED',
      null,
      isoNow(1800_000),
      isoNow(-240_000),
      isoNow(-120_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p4Id,
      m1Id,
      wRocket1,
      'DC-ORD-98410',
      'idem-dc-98410',
      'ROCKET',
      1550.00,
      'Karim Uddin',
      '01688990011',
      'karim@example.bd',
      'DC98410',
      'RKT99201122',
      '01688990011',
      isoNow(-900_000),
      'MANUAL_REVIEW_REQUIRED',
      55,
      isoNow(1200_000),
      isoNow(-1100_000),
      isoNow(-600_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_intents (id, merchant_id, wallet_id, merchant_order_id, idempotency_key, provider, amount_bdt, currency, customer_name, customer_phone, customer_email, reference_code, submitted_trx_id, submitted_sender_phone, submitted_at, status, match_confidence, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BDT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p5Id,
      m1Id,
      wBkash1,
      'DC-ORD-98425',
      'idem-dc-98425',
      'BKASH',
      1250.00,
      'Tasnim Chowdhury',
      '01711889900',
      'tasnim@example.bd',
      'DC98425',
      null,
      null,
      null,
      'CREATED',
      null,
      isoNow(2700_000),
      isoNow(-60_000),
      isoNow(-60_000),
    ],
  );

  // Notification Events
  const n1Id = newId();
  const n2Id = newId();
  const n3Id = newId();

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, package_name, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_phone, parsed_balance_bdt, parsed_tx_type, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      n1Id,
      dev1Id,
      m1Id,
      'com.bKash.customerapp',
      'BKASH',
      'evt-bkh-9x4m21q',
      sha256Hex('BKASH|BKH9X4M21Q|2450.00'),
      'bKash Payment Received',
      'You have received payment Tk 2,450.00 from 01755112233. Fee Tk 0.00. Balance Tk 42,150.00. TrxID BKH9X4M21Q.',
      2450.00,
      'BKH9X4M21Q',
      '01755112233',
      '01711002233',
      42150.00,
      'PAYMENT',
      98,
      'PARSED',
      p1Id,
      Date.now() - 190_000,
      isoNow(-180_000),
    ],
  );

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, package_name, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_phone, parsed_balance_bdt, parsed_tx_type, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      n2Id,
      dev1Id,
      m1Id,
      'com.konasl.nagad',
      'NAGAD',
      'evt-ngd-71ngd8842k',
      sha256Hex('NAGAD|71NGD8842K|4800.00'),
      'Nagad Money Received',
      'Money Received. Amount: Tk 4800.00 Sender: 01812334455 Ref: DC98409. TxnID: 71NGD8842K. Balance: Tk 29,400.00',
      4800.00,
      '71NGD8842K',
      '01812334455',
      '01819004455',
      29400.00,
      'MONEY_RECEIVED',
      99,
      'PARSED',
      p2Id,
      Date.now() - 3500_000,
      isoNow(-3480_000),
    ],
  );

  await db.execute(
    `INSERT INTO notification_events (id, device_id, merchant_id, package_name, provider, event_uid, event_hash, raw_title, raw_body_redacted, parsed_amount_bdt, parsed_trx_id, parsed_sender_phone, parsed_receiver_phone, parsed_balance_bdt, parsed_tx_type, parser_confidence, parse_status, candidate_payment_id, device_timestamp_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      n3Id,
      dev2Id,
      m1Id,
      'com.dbbl.mfs.rocket',
      'ROCKET',
      'evt-rkt-99201122',
      sha256Hex('ROCKET|RKT99201122|1500.00'),
      'DBBL Rocket Alert',
      'Tk1,500.00 received from A/C 01688990011 Fee: Tk0.00 TxnId: RKT99201122. Balance: Tk18,900.00',
      1500.00,
      'RKT99201122',
      '01688990011',
      '019120077889',
      18900.00,
      'CASH_IN',
      92,
      'PARSED',
      p4Id,
      Date.now() - 620_000,
      isoNow(-600_000),
    ],
  );

  await db.execute(
    'UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?',
    [n1Id, p1Id],
  );
  await db.execute(
    'UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?',
    [n2Id, p2Id],
  );
  await db.execute(
    'UPDATE payment_intents SET matched_notification_id = ? WHERE id = ?',
    [n3Id, p4Id],
  );

  // Match Candidates
  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      p1Id,
      n1Id,
      95,
      JSON.stringify(['PROVIDER_EXACT', 'AMOUNT_EXACT', 'TRX_ID_EXACT', 'SENDER_PHONE_MATCH']),
      'PROPOSED',
      isoNow(-180_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      p2Id,
      n2Id,
      100,
      JSON.stringify(['PROVIDER_EXACT', 'AMOUNT_EXACT', 'TRX_ID_EXACT', 'REFERENCE_MATCH']),
      'SELECTED',
      isoNow(-3480_000),
    ],
  );

  await db.execute(
    `INSERT INTO payment_match_candidates (id, payment_intent_id, notification_event_id, confidence_score, match_reasons_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      p4Id,
      n3Id,
      55,
      JSON.stringify(['PROVIDER_EXACT', 'TRX_ID_EXACT', 'AMOUNT_MISMATCH_BDT_50_SHORT']),
      'PROPOSED',
      isoNow(-600_000),
    ],
  );

  // Provider Verification for p2Id (the ONLY settled payment in seed!)
  await db.execute(
    `INSERT INTO provider_verifications (id, payment_intent_id, verification_source, provider, provider_trx_id, verified_amount_bdt, documentary_evidence_ref, provider_reference_payload_json, verifier_user_id, notes, decision, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      p2Id,
      'MANUAL_FINANCE_VERIFICATION',
      'NAGAD',
      '71NGD8842K',
      4800.00,
      'NAGAD-MERCHANT-STMT-2026-11-17-4800',
      JSON.stringify({ statementDate: '2026-11-17', portalRef: 'NGD-PORTAL-718842' }),
      reviewerId,
      'Cross-checked against Nagad Merchant Portal daily settlement statement.',
      'VERIFIED',
      isoNow(-3300_000),
    ],
  );

  // Webhook Delivery log for p2Id
  await db.execute(
    `INSERT INTO webhook_deliveries (id, merchant_id, payment_intent_id, event_type, target_url, payload_json, signature_header, attempt_count, http_status, response_body, status, last_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      m1Id,
      p2Id,
      'payment.verified_settled',
      `${env.appUrl}/api/demo-merchant-webhook`,
      JSON.stringify({
        event: 'payment.verified_settled',
        paymentId: p2Id,
        merchantOrderId: 'DC-ORD-98409',
        provider: 'NAGAD',
        amountBdt: 4800,
        trxId: '71NGD8842K',
      }),
      't=1763420000,v1=demo_signed_digest',
      1,
      200,
      '{"received":true}',
      'DELIVERED',
      isoNow(-3295_000),
      isoNow(-3300_000),
    ],
  );

  // Audit Logs
  await db.execute(
    `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, resource_type, resource_id, ip_address, after_state_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      'USER',
      reviewerId,
      'finance@takaledger.bd',
      'PAYMENT_MANUALLY_VERIFIED_SETTLED',
      'payment_intent',
      p2Id,
      '103.145.22.10',
      JSON.stringify({
        status: 'VERIFIED_SETTLED',
        documentaryEvidenceRef: 'NAGAD-MERCHANT-STMT-2026-11-17-4800',
        providerTrxId: '71NGD8842K',
      }),
      isoNow(-3300_000),
    ],
  );

  await db.execute(
    `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, resource_type, resource_id, ip_address, after_state_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      'DEVICE',
      dev1Id,
      'AND-DHAKA-SIM01',
      'NOTIFICATION_CANDIDATE_MATCHED',
      'payment_intent',
      p1Id,
      '103.98.14.52',
      JSON.stringify({
        status: 'CANDIDATE_MATCHED',
        confidence: 95,
        trxId: 'BKH9X4M21Q',
        note: 'Notification matched as candidate only; verification pending.',
      }),
      isoNow(-180_000),
    ],
  );
}
