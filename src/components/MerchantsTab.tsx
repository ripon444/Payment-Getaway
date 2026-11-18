import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, Webhook, X } from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import type { AuthUser, MerchantRow, MfsWalletRow, ProviderCode, WebhookDeliveryRow } from '../types/gateway.ts';
import { ProviderLabel } from './StatusText.tsx';

interface MerchantsTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
  wallets: MfsWalletRow[];
  onRefresh: () => void;
}

export function MerchantsTab({ user, merchants, wallets, onRefresh }: MerchantsTabProps) {
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [issuedSecretModal, setIssuedSecretModal] = useState<{ title: string; apiKey?: string; webhookSecret?: string } | null>(null);

  // Add Merchant modal
  const [showAddMerchant, setShowAddMerchant] = useState(false);
  const [mName, setMName] = useState('');
  const [mEmail, setMEmail] = useState('');
  const [mWebhook, setMWebhook] = useState('');

  // Add Wallet modal
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [wMerchantId, setWMerchantId] = useState(merchants[0]?.id ?? '');
  const [wProvider, setWProvider] = useState<ProviderCode>('BKASH');
  const [wNumber, setWNumber] = useState('');
  const [wType, setWType] = useState('MERCHANT');
  const [wTitle, setWTitle] = useState('');
  const [wError, setWError] = useState<string | null>(null);

  useEffect(() => {
    if (!wMerchantId && merchants.length > 0) setWMerchantId(merchants[0].id);
  }, [merchants, wMerchantId]);

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
        }),
      });
      setShowAddWallet(false);
      setWNumber('');
      setWTitle('');
      onRefresh();
    } catch (err) {
      setWError(err instanceof Error ? err.message : 'Failed to create wallet');
    }
  }

  async function handleRetryWebhook(id: string) {
    await apiFetch(`/api/webhooks/${id}/retry`, { method: 'POST' });
    await loadWebhooks();
  }

  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-6">
      {/* Merchants Directory */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Registered Merchants</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Isolated multi-merchant API keys, signed webhook endpoints, and settlement modes
            </p>
          </div>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setShowAddMerchant(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Merchant</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">API Key Prefix</th>
                <th className="py-2.5 px-4">Webhook Endpoint</th>
                <th className="py-2.5 px-4 text-right">Wallets</th>
                <th className="py-2.5 px-4 text-right">Payments</th>
                <th className="py-2.5 px-4 text-right">Credentials</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {merchants.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{m.name}</p>
                    <p className="text-slate-500">{m.contact_email} · {m.business_type}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">{m.api_key_prefix}••••••••</td>
                  <td className="py-3 px-4 font-mono text-slate-600 max-w-xs truncate">
                    {m.webhook_url || 'Not configured'}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{m.active_wallets}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">{m.total_payments}</td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      {isSuperAdmin && (
                        <button
                          type="button"
                          onClick={() => handleRotateKey(m.id, m.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>Rotate Key</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRotateWebhook(m.id, m.name)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                      >
                        <Webhook className="h-3 w-3" />
                        <span>Rotate HMAC</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receiving MFS Wallets */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">MFS Receiving Wallets</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              bKash, Nagad, and DBBL Rocket accounts routed to customer checkout pages
            </p>
          </div>
          {(isSuperAdmin || user.role === 'OPERATIONS') && (
            <button
              type="button"
              onClick={() => setShowAddWallet(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add MFS Wallet</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Provider</th>
                <th className="py-2.5 px-4">Account Number</th>
                <th className="py-2.5 px-4">Merchant & Title</th>
                <th className="py-2.5 px-4">Type</th>
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
                    <p className="text-slate-500">{w.merchant_name}</p>
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

      {/* Merchant API v1 Reference Snippet */}
      <div className="bg-slate-900 text-slate-100 rounded-xl p-5 space-y-2">
        <p className="text-xs font-semibold text-white">Merchant API v1 Quick Reference</p>
        <pre className="text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
{`POST /api/v1/payments
Headers:
  X-Merchant-Key: tl_live_...
  Idempotency-Key: order-99102
Body:
  { "merchantOrderId": "ORD-99102", "provider": "BKASH", "amountBdt": 1850.00, "customerPhone": "017XXXXXXXX" }

Webhook Verification (Node.js):
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(\`\${t}.\${rawBody}\`).digest('hex');`}
        </pre>
      </div>

      {/* Issued Secret One-Time Display Modal */}
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

      {/* Add Wallet Modal */}
      {showAddWallet && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Add MFS Receiving Wallet</h3>
              <button type="button" onClick={() => setShowAddWallet(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateWallet} className="space-y-3">
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provider</label>
                  <select
                    value={wProvider}
                    onChange={(e) => setWProvider(e.target.value as ProviderCode)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="BKASH">bKash</option>
                    <option value="NAGAD">Nagad</option>
                    <option value="ROCKET">DBBL Rocket</option>
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
                    <option value="AGENT">Agent</option>
                    <option value="PERSONAL">Personal</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account Number</label>
                <input
                  type="text"
                  required
                  value={wNumber}
                  onChange={(e) => setWNumber(e.target.value)}
                  placeholder="017XXXXXXXX"
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
                  placeholder="e.g. DeshiCart bKash Counter #2"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              {wError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{wError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddWallet(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Save Wallet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
