import { useCallback, useEffect, useState } from 'react';
import { Copy, Globe, KeyRound, Plus, RefreshCw, Webhook, X } from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import {
  ALL_PROVIDERS,
  type AuthUser,
  type MerchantRow,
  type MerchantWebsiteRow,
  type MfsWalletRow,
  type ProviderCode,
  type WebhookDeliveryRow,
} from '../types/gateway.ts';
import { ProviderLabel } from './StatusText.tsx';

interface MerchantsTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
  wallets: MfsWalletRow[];
  websites: MerchantWebsiteRow[];
  onRefresh: () => void;
}

export function MerchantsTab({ user, merchants, wallets, websites, onRefresh }: MerchantsTabProps) {
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [issuedSecretModal, setIssuedSecretModal] = useState<{ title: string; apiKey?: string; webhookSecret?: string } | null>(null);

  const [showAddMerchant, setShowAddMerchant] = useState(false);
  const [mName, setMName] = useState('');
  const [mEmail, setMEmail] = useState('');
  const [mWebhook, setMWebhook] = useState('');

  const [showAddWallet, setShowAddWallet] = useState(false);
  const [wMerchantId, setWMerchantId] = useState(user.merchantId ?? merchants[0]?.id ?? '');
  const [wProvider, setWProvider] = useState<ProviderCode>('BKASH');
  const [wNumber, setWNumber] = useState('');
  const [wType, setWType] = useState('MERCHANT');
  const [wTitle, setWTitle] = useState('');
  const [wBankName, setWBankName] = useState('');
  const [wError, setWError] = useState<string | null>(null);

  const [showAddWebsite, setShowAddWebsite] = useState(false);
  const [sMerchantId, setSMerchantId] = useState(user.merchantId ?? merchants[0]?.id ?? '');
  const [sName, setSName] = useState('');
  const [sDomain, setSDomain] = useState('');
  const [sPlatform, setSPlatform] = useState<'WOOCOMMERCE' | 'CUSTOM' | 'SHOPIFY' | 'LARAVEL'>('WOOCOMMERCE');
  const [sCallback, setSCallback] = useState('');
  const [sError, setSError] = useState<string | null>(null);

  useEffect(() => {
    if (!wMerchantId && (user.merchantId || merchants.length > 0)) {
      const def = user.merchantId ?? merchants[0]?.id ?? '';
      setWMerchantId(def);
      setSMerchantId(def);
    }
  }, [merchants, wMerchantId, user.merchantId]);

  const loadWebhooks = useCallback(async () => {
    const res = await apiFetch<{ deliveries: WebhookDeliveryRow[] }>('/api/webhooks');
    setDeliveries(res.deliveries);
  }, []);

  useEffect(() => {
    loadWebhooks();
  }, [loadWebhooks]);

  async function handleCreateMerchant(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch<{
      merchant: { name: string };
      credentialsOnce: { apiKey: string; webhookSecret: string };
    }>('/api/merchants', {
      method: 'POST',
      body: JSON.stringify({ name: mName, contactEmail: mEmail, webhookUrl: mWebhook || null }),
    });
    setShowAddMerchant(false);
    setMName('');
    setMEmail('');
    setMWebhook('');
    setIssuedSecretModal({
      title: `Credentials for ${res.merchant.name}`,
      apiKey: res.credentialsOnce.apiKey,
      webhookSecret: res.credentialsOnce.webhookSecret,
    });
    onRefresh();
  }

  async function handleRotateKey(merchantId: string, name: string) {
    const res = await apiFetch<{ apiKey: string }>(`/api/merchants/${merchantId}/rotate-key`, {
      method: 'POST',
    });
    setIssuedSecretModal({ title: `Rotated API Key — ${name}`, apiKey: res.apiKey });
    onRefresh();
  }

  async function handleRotateWebhook(merchantId: string, name: string) {
    const res = await apiFetch<{ webhookSecret: string }>(
      `/api/merchants/${merchantId}/rotate-webhook-secret`,
      { method: 'POST' },
    );
    setIssuedSecretModal({
      title: `Rotated Webhook HMAC Secret — ${name}`,
      webhookSecret: res.webhookSecret,
    });
  }

  async function handleCreateWallet(e: React.FormEvent) {
    e.preventDefault();
    setWError(null);
    try {
      await apiFetch('/api/merchants/wallets', {
        method: 'POST',
        body: JSON.stringify({
          merchantId: wMerchantId,
          provider: wProvider,
          accountNumber: wNumber,
          accountType: wType,
          accountTitle: wTitle,
          bankName: wBankName.trim() || null,
        }),
      });
      setShowAddWallet(false);
      setWNumber('');
      setWTitle('');
      setWBankName('');
      onRefresh();
    } catch (err) {
      setWError(err instanceof Error ? err.message : 'Failed to save payment account');
    }
  }

  async function handleCreateWebsite(e: React.FormEvent) {
    e.preventDefault();
    setSError(null);
    try {
      await apiFetch('/api/merchants/websites', {
        method: 'POST',
        body: JSON.stringify({
          merchantId: sMerchantId,
          siteName: sName,
          domain: sDomain,
          platform: sPlatform,
          callbackUrl: sCallback.trim() || null,
        }),
      });
      setShowAddWebsite(false);
      setSName('');
      setSDomain('');
      setSCallback('');
      onRefresh();
    } catch (err) {
      setSError(err instanceof Error ? err.message : 'Failed to register website');
    }
  }

  async function handleRetryWebhook(id: string) {
    await apiFetch(`/api/webhooks/${id}/retry`, { method: 'POST' });
    await loadWebhooks();
  }

  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const canRotateOwn = isSuperAdmin || user.role === 'MERCHANT_ADMIN';
  const canManageResources = isSuperAdmin || user.role === 'OPERATIONS' || user.role === 'MERCHANT_ADMIN';

  return (
    <div className="space-y-6">
      {/* Merchants & Balances */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {user.role === 'MERCHANT_ADMIN' ? 'Merchant Profile, API Key & Balance' : 'Registered Merchants & Settlement Balances'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Tenant-isolated API keys, HMAC webhook secrets, fee tiers, and settled balances (updated only on SUCCESS)
            </p>
          </div>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setShowAddMerchant(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Register Merchant</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">API Key Prefix</th>
                <th className="py-2.5 px-4 text-right">Fee %</th>
                <th className="py-2.5 px-4 text-right">Settled Balance</th>
                <th className="py-2.5 px-4 text-right">Sites / Wallets</th>
                <th className="py-2.5 px-4 text-right">Credentials</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {merchants.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{m.name}</p>
                    <p className="text-slate-500">{m.contact_email} · {m.webhook_url || 'No webhook URL'}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">{m.api_key_prefix}••••••••</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{Number(m.fee_percent ?? 1.5).toFixed(2)}%</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-700">
                    {formatBdt(m.settled_balance_bdt)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    {m.active_websites ?? 0} sites · {m.active_wallets} accts
                  </td>
                  <td className="py-3 px-4 text-right">
                    {canRotateOwn && (
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRotateKey(m.id, m.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>Rotate Key</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotateWebhook(m.id, m.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <Webhook className="h-3 w-3" />
                          <span>Rotate HMAC</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Merchant Websites */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Connected Merchant Websites & Storefronts</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Multiple WooCommerce, Laravel, Shopify, and custom domains per merchant account
            </p>
          </div>
          {canManageResources && (
            <button
              type="button"
              onClick={() => setShowAddWebsite(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg"
            >
              <Globe className="h-3.5 w-3.5" />
              <span>Add Website</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Storefront</th>
                <th className="py-2.5 px-4">Domain</th>
                <th className="py-2.5 px-4">Platform</th>
                <th className="py-2.5 px-4">Callback URL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {websites.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">No merchant websites registered yet.</td>
                </tr>
              ) : (
                websites.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{s.site_name}</p>
                      <p className="text-slate-500">{s.merchant_name}</p>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-900">{s.domain}</td>
                    <td className="py-3 px-4 font-mono text-slate-700">{s.platform}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">{s.callback_url || 'Default merchant webhook'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receiving MFS & Bank Wallets */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Receiving Payment Accounts (7 Providers)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Personal, Merchant, Agent, CellFin, Bangla QR, and Bank accounts routed to checkout sessions
            </p>
          </div>
          {canManageResources && (
            <button
              type="button"
              onClick={() => setShowAddWallet(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Payment Account</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Provider</th>
                <th className="py-2.5 px-4">Account Number</th>
                <th className="py-2.5 px-4">Merchant & Bank</th>
                <th className="py-2.5 px-4">Mode</th>
                <th className="py-2.5 px-4 text-right">Daily Received / Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {wallets.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4"><ProviderLabel provider={w.provider} /></td>
                  <td className="py-3 px-4 font-mono font-medium text-slate-900">{w.account_number}</td>
                  <td className="py-3 px-4">
                    <p className="font-medium text-slate-900">{w.account_title}</p>
                    <p className="text-slate-500">{w.merchant_name}{w.bank_name ? ` · ${w.bank_name}` : ''}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">{w.account_type}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                    {formatBdt(w.daily_received_bdt)} / {formatBdt(w.daily_limit_bdt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Signed Webhook Delivery Log */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Signed Merchant Webhook Deliveries</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Signed with <span className="font-mono">X-Gateway-Signature: t=&lt;unix&gt;,v1=&lt;hmac_sha256&gt;</span>
            </p>
          </div>
          <button
            type="button"
            onClick={loadWebhooks}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Event / Order</th>
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Status / HTTP</th>
                <th className="py-2.5 px-4 text-right">Attempts</th>
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {deliveries.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-mono font-medium text-slate-900">{d.event_type}</p>
                    <p className="font-mono text-slate-500">{d.merchant_order_id}</p>
                  </td>
                  <td className="py-3 px-4 text-slate-700">{d.merchant_name}</td>
                  <td className="py-3 px-4 font-mono">
                    <span className={d.status === 'DELIVERED' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                      {d.status}
                    </span>{' '}
                    {d.http_status ? `(${d.http_status})` : ''}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{d.attempt_count}</td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                    {formatTimestamp(d.last_attempt_at || d.created_at)}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => handleRetryWebhook(d.id)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                    >
                      Redeliver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* API v1 & WooCommerce Plugin Reference */}
      <div className="bg-slate-900 text-slate-100 rounded-xl p-5 space-y-2">
        <p className="text-xs font-semibold text-white">Merchant API v1 & WooCommerce Plugin Reference</p>
        <pre className="text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
{`GET  /api/v1/methods   (returns enabled providers: BKASH, NAGAD, ROCKET, UPAY, CELLFIN, BANGLA_QR, BANK_SMS)
POST /api/v1/payments
Headers:
  X-Merchant-Key: tl_live_...
  Idempotency-Key: order-99102
Body:
  { "merchantOrderId": "ORD-99102", "provider": "BANGLA_QR", "amountBdt": 1850.00, "customerPhone": "017XXXXXXXX" }

WooCommerce Plugin:
  Upload /woocommerce-plugin/takaledger-gateway/ to wp-content/plugins/
  Webhook endpoint: https://yourstore.bd/wp-json/takaledger/v1/webhook (verifies X-Gateway-Signature HMAC)`}
        </pre>
      </div>

      {/* Issued Secret Modal */}
      {issuedSecretModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{issuedSecretModal.title}</h3>
              <button type="button" onClick={() => setIssuedSecretModal(null)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 p-2.5 rounded-lg">
              Store these credentials securely now. They are hashed/encrypted at rest and will not be shown again.
            </p>
            {issuedSecretModal.apiKey && (
              <div>
                <p className="text-xs font-medium text-slate-700 mb-1">Merchant API Key</p>
                <div className="flex items-center gap-2 bg-slate-100 p-2.5 rounded-lg font-mono text-xs break-all">
                  <span className="flex-1">{issuedSecretModal.apiKey}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(issuedSecretModal.apiKey!)}
                    className="p-1 text-slate-600 hover:text-slate-900"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
            {issuedSecretModal.webhookSecret && (
              <div>
                <p className="text-xs font-medium text-slate-700 mb-1">Webhook HMAC Secret</p>
                <div className="flex items-center gap-2 bg-slate-100 p-2.5 rounded-lg font-mono text-xs break-all">
                  <span className="flex-1">{issuedSecretModal.webhookSecret}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(issuedSecretModal.webhookSecret!)}
                    className="p-1 text-slate-600 hover:text-slate-900"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Merchant Modal */}
      {showAddMerchant && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Register Merchant</h3>
              <button type="button" onClick={() => setShowAddMerchant(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateMerchant} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Business Name</label>
                <input
                  type="text"
                  required
                  value={mName}
                  onChange={(e) => setMName(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Finance Contact Email</label>
                <input
                  type="email"
                  required
                  value={mEmail}
                  onChange={(e) => setMEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Webhook URL</label>
                <input
                  type="url"
                  value={mWebhook}
                  onChange={(e) => setMWebhook(e.target.value)}
                  placeholder="https://merchant.bd/webhooks/takaledger"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddMerchant(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Create Merchant
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Website Modal */}
      {showAddWebsite && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Add Merchant Website</h3>
              <button type="button" onClick={() => setShowAddWebsite(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateWebsite} className="space-y-3">
              {user.role !== 'MERCHANT_ADMIN' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={sMerchantId}
                    onChange={(e) => setSMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Storefront Name</label>
                <input
                  type="text"
                  required
                  value={sName}
                  onChange={(e) => setSName(e.target.value)}
                  placeholder="e.g. DeshiCart WooCommerce Store"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Domain</label>
                  <input
                    type="text"
                    required
                    value={sDomain}
                    onChange={(e) => setSDomain(e.target.value)}
                    placeholder="shop.deshicart.com.bd"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Platform</label>
                  <select
                    value={sPlatform}
                    onChange={(e) => setSPlatform(e.target.value as 'WOOCOMMERCE' | 'CUSTOM' | 'SHOPIFY' | 'LARAVEL')}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="WOOCOMMERCE">WooCommerce</option>
                    <option value="CUSTOM">Custom API</option>
                    <option value="LARAVEL">Laravel</option>
                    <option value="SHOPIFY">Shopify</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Callback URL (Optional)</label>
                <input
                  type="url"
                  value={sCallback}
                  onChange={(e) => setSCallback(e.target.value)}
                  placeholder="https://shop.deshicart.com.bd/wp-json/takaledger/v1/webhook"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              {sError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{sError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddWebsite(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Register Website
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Payment Account Modal */}
      {showAddWallet && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Add Receiving Payment Account</h3>
              <button type="button" onClick={() => setShowAddWallet(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateWallet} className="space-y-3">
              {user.role !== 'MERCHANT_ADMIN' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={wMerchantId}
                    onChange={(e) => setWMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provider</label>
                  <select
                    value={wProvider}
                    onChange={(e) => setWProvider(e.target.value as ProviderCode)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {ALL_PROVIDERS.map((p) => (
                      <option key={p.code} value={p.code}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Account Type</label>
                  <select
                    value={wType}
                    onChange={(e) => setWType(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="MERCHANT">Merchant</option>
                    <option value="PERSONAL">Personal</option>
                    <option value="AGENT">Agent</option>
                    <option value="BANK_ACCOUNT">Bank Account</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Wallet / Account Number</label>
                <input
                  type="text"
                  required
                  value={wNumber}
                  onChange={(e) => setWNumber(e.target.value)}
                  placeholder="017XXXXXXXX or Bank A/C"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account Title</label>
                <input
                  type="text"
                  required
                  value={wTitle}
                  onChange={(e) => setWTitle(e.target.value)}
                  placeholder="e.g. DeshiCart Upay Counter"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bank Name (For Bangla QR / CellFin / Bank SMS)</label>
                <input
                  type="text"
                  value={wBankName}
                  onChange={(e) => setWBankName(e.target.value)}
                  placeholder="e.g. The City Bank PLC / Islami Bank"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              {wError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{wError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddWallet(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Save Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
