import { getDb, isoNow } from '../db/client.ts';

export interface SubscriptionPackageRow {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  monthly_price_bdt: number;
  yearly_price_bdt: number;
  max_websites: number;
  max_devices: number;
  monthly_tx_limit: number;
  allowed_providers_json: string;
  allow_personal_wallets: number;
  allow_auto_matching: number;
  allow_webhooks: number;
  allow_api_access: number;
  history_retention_days: number;
  support_level: string;
  is_active: number;
  sort_order: number;
}

export interface MerchantEntitlements {
  merchantId: string;
  merchantStatus: string;
  hasSubscription: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  daysRemaining: number;
  isExpired: boolean;
  package: {
    id: string;
    code: string;
    name: string;
    maxWebsites: number;
    maxDevices: number;
    monthlyTxLimit: number;
    allowedProviders: string[];
    allowPersonalWallets: boolean;
    allowAutoMatching: boolean;
    allowWebhooks: boolean;
    allowApiAccess: boolean;
    historyRetentionDays: number;
    supportLevel: string;
  } | null;
  usage: {
    websitesUsed: number;
    devicesUsed: number;
    monthlyTxUsed: number;
  };
}

export class EntitlementError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(message: string, statusCode = 403, code = 'PLAN_ENTITLEMENT_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function sweepExpiredSubscriptions(): Promise<number> {
  const db = getDb();
  const now = isoNow();
  const res = await db.execute(
    `UPDATE merchant_subscriptions
     SET status = 'EXPIRED', updated_at = ?
     WHERE status IN ('ACTIVE', 'TRIAL') AND current_period_end < ?`,
    [now, now],
  );
  return res.changes;
}

function parseUtcIso(ts: string | null): number {
  if (!ts) return 0;
  const normalized = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export async function getMerchantEntitlements(merchantId: string): Promise<MerchantEntitlements> {
  await sweepExpiredSubscriptions();
  const db = getDb();

  const merchant = await db.queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM merchants WHERE id = ?',
    [merchantId],
  );

  const sub = await db.queryOne<{
    id: string;
    status: string;
    billing_cycle: 'MONTHLY' | 'YEARLY';
    current_period_start: string;
    current_period_end: string;
    tx_used_current_period: number;
    pkg_id: string;
    pkg_code: string;
    pkg_name: string;
    max_websites: number;
    max_devices: number;
    monthly_tx_limit: number;
    allowed_providers_json: string;
    allow_personal_wallets: number;
    allow_auto_matching: number;
    allow_webhooks: number;
    allow_api_access: number;
    history_retention_days: number;
    support_level: string;
  }>(
    `SELECT s.id, s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
            s.tx_used_current_period,
            p.id AS pkg_id, p.code AS pkg_code, p.name AS pkg_name,
            p.max_websites, p.max_devices, p.monthly_tx_limit, p.allowed_providers_json,
            p.allow_personal_wallets, p.allow_auto_matching, p.allow_webhooks,
            p.allow_api_access, p.history_retention_days, p.support_level
     FROM merchant_subscriptions s
     JOIN subscription_packages p ON p.id = s.package_id
     WHERE s.merchant_id = ?
     ORDER BY CASE WHEN s.status IN ('ACTIVE', 'TRIAL') THEN 0 ELSE 1 END, s.created_at DESC
     LIMIT 1`,
    [merchantId],
  );

  const websitesRow = await db.queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM merchant_websites WHERE merchant_id = ? AND is_active = 1',
    [merchantId],
  );
  const devicesRow = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM devices WHERE merchant_id = ? AND status IN ('PENDING_PAIRING', 'ACTIVE')",
    [merchantId],
  );

  const periodStart = sub?.current_period_start ?? isoNow(-30 * 86400_000);
  const txRow = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM payment_intents WHERE merchant_id = ? AND mode = 'LIVE' AND created_at >= ?",
    [merchantId, periodStart],
  );

  const endMs = parseUtcIso(sub?.current_period_end ?? null);
  const daysRemaining = sub ? Math.max(0, Math.ceil((endMs - Date.now()) / 86400_000)) : 0;
  const isExpired = !sub || !['ACTIVE', 'TRIAL'].includes(sub.status) || endMs < Date.now();

  let allowedProviders: string[] = ['BKASH', 'NAGAD', 'ROCKET'];
  if (sub?.allowed_providers_json) {
    try {
      allowedProviders = JSON.parse(sub.allowed_providers_json) as string[];
    } catch {
      allowedProviders = ['BKASH', 'NAGAD', 'ROCKET'];
    }
  }

  return {
    merchantId,
    merchantStatus: merchant?.status ?? 'UNKNOWN',
    hasSubscription: Boolean(sub),
    subscriptionId: sub?.id ?? null,
    subscriptionStatus: sub?.status ?? 'NONE',
    billingCycle: sub?.billing_cycle ?? 'MONTHLY',
    currentPeriodStart: sub?.current_period_start ?? null,
    currentPeriodEnd: sub?.current_period_end ?? null,
    daysRemaining,
    isExpired,
    package: sub
      ? {
          id: sub.pkg_id,
          code: sub.pkg_code,
          name: sub.pkg_name,
          maxWebsites: Number(sub.max_websites),
          maxDevices: Number(sub.max_devices),
          monthlyTxLimit: Number(sub.monthly_tx_limit),
          allowedProviders,
          allowPersonalWallets: Number(sub.allow_personal_wallets) === 1,
          allowAutoMatching: Number(sub.allow_auto_matching) === 1,
          allowWebhooks: Number(sub.allow_webhooks) === 1,
          allowApiAccess: Number(sub.allow_api_access) === 1,
          historyRetentionDays: Number(sub.history_retention_days),
          supportLevel: sub.support_level,
        }
      : null,
    usage: {
      websitesUsed: Number(websitesRow?.cnt ?? 0),
      devicesUsed: Number(devicesRow?.cnt ?? 0),
      monthlyTxUsed: Number(txRow?.cnt ?? 0),
    },
  };
}

export async function assertWebsiteQuota(merchantId: string): Promise<MerchantEntitlements> {
  const ent = await getMerchantEntitlements(merchantId);
  if (ent.merchantStatus !== 'ACTIVE') {
    throw new EntitlementError(`Merchant account is ${ent.merchantStatus}.`, 403, 'MERCHANT_SUSPENDED');
  }
  if (ent.isExpired || !ent.package) {
    throw new EntitlementError(
      'Active subscription required to register new websites. Please subscribe or renew a package.',
      402,
      'SUBSCRIPTION_EXPIRED',
    );
  }
  if (ent.usage.websitesUsed >= ent.package.maxWebsites) {
    throw new EntitlementError(
      `Website limit reached (${ent.usage.websitesUsed}/${ent.package.maxWebsites} on ${ent.package.name} plan). Upgrade your package to connect more domains.`,
      403,
      'WEBSITE_QUOTA_EXCEEDED',
    );
  }
  return ent;
}

export async function assertDeviceQuota(merchantId: string): Promise<MerchantEntitlements> {
  const ent = await getMerchantEntitlements(merchantId);
  if (ent.merchantStatus !== 'ACTIVE') {
    throw new EntitlementError(`Merchant account is ${ent.merchantStatus}.`, 403, 'MERCHANT_SUSPENDED');
  }
  if (ent.isExpired || !ent.package) {
    throw new EntitlementError(
      'Active subscription required to pair Android listener devices.',
      402,
      'SUBSCRIPTION_EXPIRED',
    );
  }
  if (ent.usage.devicesUsed >= ent.package.maxDevices) {
    throw new EntitlementError(
      `Android device limit reached (${ent.usage.devicesUsed}/${ent.package.maxDevices} on ${ent.package.name} plan). Upgrade your package to add more devices.`,
      403,
      'DEVICE_QUOTA_EXCEEDED',
    );
  }
  return ent;
}

export async function assertPaymentCreationAllowed(
  merchantId: string,
  opts: { provider: string; accountType?: string; mode?: 'LIVE' | 'TEST' },
): Promise<MerchantEntitlements> {
  const ent = await getMerchantEntitlements(merchantId);
  if (ent.merchantStatus !== 'ACTIVE') {
    throw new EntitlementError(`Merchant account is ${ent.merchantStatus}.`, 403, 'MERCHANT_SUSPENDED');
  }
  if (ent.isExpired || !ent.package) {
    throw new EntitlementError(
      'Merchant subscription has expired. Gateway API access is paused until renewal (historical records remain available).',
      402,
      'SUBSCRIPTION_EXPIRED',
    );
  }
  if (!ent.package.allowApiAccess) {
    throw new EntitlementError('API access is disabled on your current package.', 403, 'API_DISABLED');
  }
  if (!ent.package.allowedProviders.includes(opts.provider)) {
    throw new EntitlementError(
      `Provider ${opts.provider} is not included in the ${ent.package.name} package. Allowed: ${ent.package.allowedProviders.join(', ')}.`,
      403,
      'PROVIDER_NOT_IN_PLAN',
    );
  }
  if (opts.accountType === 'PERSONAL' && !ent.package.allowPersonalWallets) {
    throw new EntitlementError(
      `Personal wallet accounts are not included in the ${ent.package.name} package.`,
      403,
      'PERSONAL_WALLET_NOT_IN_PLAN',
    );
  }
  if ((opts.mode ?? 'LIVE') === 'LIVE' && ent.usage.monthlyTxUsed >= ent.package.monthlyTxLimit) {
    throw new EntitlementError(
      `Monthly transaction quota exceeded (${ent.usage.monthlyTxUsed}/${ent.package.monthlyTxLimit} on ${ent.package.name} plan). Please upgrade to continue accepting live payments.`,
      402,
      'MONTHLY_TX_LIMIT_EXCEEDED',
    );
  }
  return ent;
}

export async function assertWalletCreationAllowed(
  merchantId: string,
  opts: { provider: string; accountType: string },
): Promise<MerchantEntitlements> {
  const ent = await getMerchantEntitlements(merchantId);
  if (ent.merchantStatus !== 'ACTIVE') {
    throw new EntitlementError(`Merchant account is ${ent.merchantStatus}.`, 403, 'MERCHANT_SUSPENDED');
  }
  if (!ent.isExpired && ent.package) {
    if (!ent.package.allowedProviders.includes(opts.provider)) {
      throw new EntitlementError(
        `Provider ${opts.provider} requires a higher package than ${ent.package.name}.`,
        403,
        'PROVIDER_NOT_IN_PLAN',
      );
    }
    if (opts.accountType === 'PERSONAL' && !ent.package.allowPersonalWallets) {
      throw new EntitlementError(
        `Personal wallets are not enabled on the ${ent.package.name} package.`,
        403,
        'PERSONAL_WALLET_NOT_IN_PLAN',
      );
    }
  }
  return ent;
}
