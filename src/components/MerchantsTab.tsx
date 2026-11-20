import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp, getStoredToken } from '../lib/api.ts';
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
  const [issuedSecretModal, setIssuedSecretModal] = useState<{
    title: string;
    apiKey?: string;
    testApiKey?: string;
    apiSecret?: string;
    webhookSecret?: string;
  } | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Add Merchant
  const [showAddMerchant, setShowAddMerchant] = useState(false);
  const [mName, setMName] = useState('');
  const [mEmail, setMEmail] = useState('');
  const [mWebhook, setMWebhook] = useState('');

  // Merchant Settings Modal
  const [settingsMerchant, setSettingsMerchant] = useState<MerchantRow | null>(null);
  const [cfgWebhookUrl, setCfgWebhookUrl] = useState('');
  const [cfgPhone, setCfgPhone] = useState('');
  const [cfgAddress, setCfgAddress] = useState('');
  const [cfgAutoPolicy, setCfgAutoPolicy] = useState<'DETERMINISTIC_PERSONAL_PROOF' | 'STRICT_API_ONLY'>(
    'DETERMINISTIC_PERSONAL_PROOF',
  );

  // Add / Edit Wallet
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [editingWallet, setEditingWallet] = useState<MfsWalletRow | null>(null);
  const [wMerchantId, setWMerchantId] = useState(user.merchantId ?? merchants[0]?.id ?? '');
  const [wProvider, setWProvider] = useState<ProviderCode>('BKASH');
  const [wNumber, setWNumber] = useState('');
  const [wType, setWType] = useState('PERSONAL');
  const [wTitle, setWTitle] = useState('');
  const [wBankName, setWBankName] = useState('');
  const [wDailyLimit, setWDailyLimit] = useState('250000');
  const [wError, setWError] = useState<string | null>(null);

  // Add / Edit Website
  const [showWebsiteModal, setShowWebsiteModal] = useState(false);
  const [editingWebsite, setEditingWebsite] = useState<MerchantWebsiteRow | null>(null);
  const [sMerchantId, setSMerchantId] = useState(user.merchantId ?? merchants[0]?.id ?? '');
  const [sName, setSName] = useState('');
  const [sDomain, setSDomain] = useState('');
  const [sPlatform, setSPlatform] = useState<'WOOCOMMERCE' | 'CUSTOM' | 'SHOPIFY' | 'LARAVEL'>('WOOCOMMERCE');
  const [sCallback, setSCallback] = useState('');
  const [sSuccessUrl, setSSuccessUrl] = useState('');
  const [sCancelUrl, setSCancelUrl] = useState('');
  const [sMode, setSMode] = useState<'LIVE' | 'TEST'>('LIVE');
  const [sError, setSError] = useState<string | null>(null);

  // Domain Verification Modal
  const [verifySite, setVerifySite] = useState<MerchantWebsiteRow | null>(null);
  const [verifyMethod, setVerifyMethod] = useState<'SANDBOX_CONFIRM' | 'DNS_TXT' | 'HTML_META' | 'HTTP_FILE'>(
    'SANDBOX_CONFIRM',
  );
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

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

  async function handleDownloadReport(format: 'csv' | 'json') {
    const token = getStoredToken();
    const res = await fetch(`/api/merchant/reports/export?format=${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      setErrorBanner('Failed to download report');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `takaledger-report-${Date.now()}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCreateMerchant(e: React.FormEvent) {
    e.preventDefault();
    const res = await apiFetch<{
      merchant: { name: string };
      credentialsOnce: { apiKey: string; testApiKey: string; apiSecret: string; webhookSecret: string };
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
      testApiKey: res.credentialsOnce.testApiKey,
      apiSecret: res.credentialsOnce.apiSecret,
      webhookSecret: res.credentialsOnce.webhookSecret,
    });
    onRefresh();
  }

  async function handleRotateKey(merchantId: string, name: string) {
    const res = await apiFetch<{ apiKey: string }>(`/api/merchants/${merchantId}/rotate-key`, { method: 'POST' });
    setIssuedSecretModal({ title: `Rotated Live API Key — ${name}`, apiKey: res.apiKey });
    onRefresh();
  }

  async function handleRotateTestKey(merchantId: string, name: string) {
    const res = await apiFetch<{ testApiKey: string }>(`/api/merchants/${merchantId}/rotate-test-key`, {
      method: 'POST',
    });
    setIssuedSecretModal({ title: `Rotated Test Sandbox Key — ${name}`, testApiKey: res.testApiKey });
    onRefresh();
  }

  async function handleRotateApiSecret(merchantId: string, name: string) {
    const res = await apiFetch<{ apiSecret: string }>(`/api/merchants/${merchantId}/rotate-api-secret`, {
      method: 'POST',
    });
    setIssuedSecretModal({ title: `Rotated API Secret — ${name}`, apiSecret: res.apiSecret });
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

  async function handleSendTestWebhook(merchantId: string) {
    setStatusBanner(null);
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ delivered: boolean; httpStatus: number | null; targetUrl: string }>(
        `/api/merchants/${merchantId}/test-webhook`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setStatusBanner(
        res.delivered
          ? `Test webhook delivered cleanly (HTTP ${res.httpStatus}) to ${res.targetUrl}`
          : `Test webhook dispatched to ${res.targetUrl} (HTTP ${res.httpStatus ?? 'Unreachable'})`,
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Test webhook failed');
    }
  }

  function openMerchantSettings(m: MerchantRow) {
    setSettingsMerchant(m);
    setCfgWebhookUrl(m.webhook_url || '');
    setCfgPhone(m.business_phone || '');
    setCfgAddress(m.business_address || '');
    setCfgAutoPolicy(
      m.auto_verify_policy === 'STRICT_API_ONLY' ? 'STRICT_API_ONLY' : 'DETERMINISTIC_PERSONAL_PROOF',
    );
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settingsMerchant) return;
    await apiFetch(`/api/merchants/${settingsMerchant.id}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        webhookUrl: cfgWebhookUrl.trim() || null,
        businessPhone: cfgPhone.trim() || null,
        businessAddress: cfgAddress.trim() || null,
        autoVerifyPolicy: cfgAutoPolicy,
      }),
    });
    setSettingsMerchant(null);
    setStatusBanner('Merchant settings & Zero-TrxID verification policy updated.');
    onRefresh();
  }

  function openAddWallet() {
    setEditingWallet(null);
    setWProvider('BKASH');
    setWNumber('');
    setWType('PERSONAL');
    setWTitle('');
    setWBankName('');
    setWDailyLimit('250000');
    setWError(null);
    setShowAddWallet(true);
  }

  function openEditWallet(w: MfsWalletRow) {
    setEditingWallet(w);
    setWProvider(w.provider);
    setWNumber(w.account_number);
    setWType(w.account_type);
    setWTitle(w.account_title);
    setWBankName(w.bank_name || '');
    setWDailyLimit(String(w.daily_limit_bdt));
    setWError(null);
    setShowAddWallet(true);
  }

  async function handleSaveWallet(e: React.FormEvent) {
    e.preventDefault();
    setWError(null);
    try {
      if (editingWallet) {
        await apiFetch(`/api/merchants/wallets/${editingWallet.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            accountTitle: wTitle,
            accountType: wType,
            bankName: wBankName.trim() || null,
            dailyLimitBdt: Number(wDailyLimit),
          }),
        });
      } else {
        await apiFetch('/api/merchants/wallets', {
          method: 'POST',
          body: JSON.stringify({
            merchantId: wMerchantId,
            provider: wProvider,
            accountNumber: wNumber,
            accountType: wType,
            accountTitle: wTitle,
            bankName: wBankName.trim() || null,
            dailyLimitBdt: Number(wDailyLimit),
          }),
        });
      }
      setShowAddWallet(false);
      onRefresh();
    } catch (err) {
      setWError(err instanceof Error ? err.message : 'Failed to save payment account');
    }
  }

  async function handleToggleWalletActive(w: MfsWalletRow) {
    await apiFetch(`/api/merchants/wallets/${w.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: Number(w.is_active) !== 1 }),
    });
    onRefresh();
  }

  async function handleDeleteWallet(w: MfsWalletRow) {
    await apiFetch(`/api/merchants/wallets/${w.id}`, { method: 'DELETE' });
    onRefresh();
  }

  function openAddWebsite() {
    setEditingWebsite(null);
    setSName('');
    setSDomain('');
    setSPlatform('WOOCOMMERCE');
    setSCallback('');
    setSSuccessUrl('');
    setSCancelUrl('');
    setSMode('LIVE');
    setSError(null);
    setShowWebsiteModal(true);
  }

  function openEditWebsite(s: MerchantWebsiteRow) {
    setEditingWebsite(s);
    setSName(s.site_name);
    setSDomain(s.domain);
    setSPlatform(s.platform);
    setSCallback(s.callback_url || '');
    setSSuccessUrl(s.success_url || '');
    setSCancelUrl(s.cancel_url || '');
    setSMode(s.mode === 'TEST' ? 'TEST' : 'LIVE');
    setSError(null);
    setShowWebsiteModal(true);
  }

  async function handleSaveWebsite(e: React.FormEvent) {
    e.preventDefault();
    setSError(null);
    try {
      if (editingWebsite) {
        await apiFetch(`/api/merchants/websites/${editingWebsite.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            siteName: sName,
            callbackUrl: sCallback.trim() || null,
            successUrl: sSuccessUrl.trim() || null,
            cancelUrl: sCancelUrl.trim() || null,
            mode: sMode,
          }),
        });
      } else {
        await apiFetch('/api/merchants/websites', {
          method: 'POST',
          body: JSON.stringify({
            merchantId: sMerchantId,
            siteName: sName,
            domain: sDomain,
            platform: sPlatform,
            callbackUrl: sCallback.trim() || null,
            successUrl: sSuccessUrl.trim() || undefined,
            cancelUrl: sCancelUrl.trim() || undefined,
            mode: sMode,
          }),
        });
      }
      setShowWebsiteModal(false);
      onRefresh();
    } catch (err) {
      setSError(err instanceof Error ? err.message : 'Failed to save website');
    }
  }

  async function handleDeleteWebsite(siteId: string) {
    await apiFetch(`/api/merchants/websites/${siteId}`, { method: 'DELETE' });
    onRefresh();
  }

  async function handleVerifyWebsite() {
    if (!verifySite) return;
    setVerifying(true);
    setVerifyMsg(null);
    try {
      const res = await apiFetch<{ verified: boolean; detail: string }>(
        `/api/merchants/websites/${verifySite.id}/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            method: verifyMethod,
            confirmToken: verifySite.verification_token,
          }),
        },
      );
      setVerifyMsg(res.detail || 'Domain ownership verified.');
      onRefresh();
    } catch (err) {
      setVerifyMsg(err instanceof Error ? err.message : 'Domain verification failed');
    } finally {
      setVerifying(false);
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
      {statusBanner && (
        <div className="p-3.5 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between">
          <span>{statusBanner}</span>
          <button type="button" onClick={() => setStatusBanner(null)} className="text-emerald-700">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {errorBanner && (
        <div className="p-3.5 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between">
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner(null)} className="text-rose-700">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Merchants, Keys, Subscription Status & Export */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {user.role === 'MERCHANT_ADMIN'
                ? 'Merchant Profile, Live & Test API Credentials'
                : 'Registered Merchants & SaaS Subscriptions'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Live (`tl_live_`) & Test (`tl_test_`) API keys, API secrets, Zero-TrxID auto-verify policy, and financial exports
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleDownloadReport('csv')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleDownloadReport('json')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export JSON</span>
            </button>
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setShowAddMerchant(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Register Merchant</span>
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Merchant / Plan</th>
                <th className="py-2.5 px-4">Live & Test Keys</th>
                <th className="py-2.5 px-4 text-right">Settled Balance</th>
                <th className="py-2.5 px-4 text-right">Sites / Wallets</th>
                <th className="py-2.5 px-4 text-right">Credential & Webhook Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {merchants.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">
                      {m.name}{' '}
                      <span className="font-mono text-[11px] font-medium text-teal-700">
                        {m.package_name || 'Standard'} ({m.subscription_status || m.status})
                      </span>
                    </p>
                    <p className="text-slate-500">
                      {m.contact_email} · {m.webhook_url || 'No default webhook URL'}
                    </p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700 space-y-0.5">
                    <p>Live: {m.api_key_prefix}••••</p>
                    <p className="text-amber-700">Test: {m.test_api_key_prefix || 'tl_test_'}••••</p>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-700">
                    {formatBdt(m.settled_balance_bdt)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    {m.active_websites ?? 0} sites · {m.active_wallets} accts
                  </td>
                  <td className="py-3 px-4 text-right">
                    {canRotateOwn && (
                      <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openMerchantSettings(m)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <Settings className="h-3 w-3" />
                          <span>Settings</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSendTestWebhook(m.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
                        >
                          <Send className="h-3 w-3" />
                          <span>Test Webhook</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotateKey(m.id, m.name)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>Live Key</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotateTestKey(m.id, m.name)}
                          className="px-2 py-1 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md"
                        >
                          Test Key
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotateApiSecret(m.id, m.name)}
                          className="px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          API Secret
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRotateWebhook(m.id, m.name)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          <Webhook className="h-3 w-3" />
                          <span>HMAC</span>
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

      {/* Connected Merchant Websites + Verification */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Connected Merchant Websites & Storefronts</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure Live/Test mode, Success & Cancel redirects, Callback URLs, and domain ownership verification
            </p>
          </div>
          {canManageResources && (
            <button
              type="button"
              onClick={openAddWebsite}
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
                <th className="py-2.5 px-4">Domain / Mode</th>
                <th className="py-2.5 px-4">Verification</th>
                <th className="py-2.5 px-4">URLs (Success / Callback)</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {websites.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">
                    No merchant websites registered yet.
                  </td>
                </tr>
              ) : (
                websites.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{s.site_name}</p>
                      <p className="text-slate-500">
                        {s.merchant_name} · {s.platform}
                      </p>
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <p className="text-slate-900">{s.domain}</p>
                      <p className={s.mode === 'TEST' ? 'text-amber-700 font-semibold' : 'text-teal-700 font-semibold'}>
                        {s.mode || 'LIVE'} MODE
                      </p>
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {s.verification_status === 'VERIFIED' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>VERIFIED</span>
                        </span>
                      ) : (
                        <span className="text-amber-700 font-medium">{s.verification_status || 'PENDING'}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 max-w-xs truncate">
                      <p className="truncate">OK: {s.success_url || 'Default'}</p>
                      <p className="truncate">WH: {s.callback_url || 'Default merchant webhook'}</p>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {canManageResources && (
                        <div className="inline-flex items-center gap-1.5">
                          {s.verification_status !== 'VERIFIED' && (
                            <button
                              type="button"
                              onClick={() => {
                                setVerifySite(s);
                                setVerifyMsg(null);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
                            >
                              <ShieldCheck className="h-3 w-3" />
                              <span>Verify</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditWebsite(s)}
                            className="p-1.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md"
                            title="Edit website"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteWebsite(s.id)}
                            className="p-1.5 text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 rounded-md"
                            title="Delete website"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receiving MFS & Bank Wallets CRUD */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Receiving Payment Accounts (7 Providers)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Personal, Merchant, Agent, CellFin, Bangla QR, and Bank accounts routed to Zero-TrxID checkout
            </p>
          </div>
          {canManageResources && (
            <button
              type="button"
              onClick={openAddWallet}
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
                <th className="py-2.5 px-4">Title & Bank</th>
                <th className="py-2.5 px-4">Mode / Status</th>
                <th className="py-2.5 px-4 text-right">Daily Received / Limit</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {wallets.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <ProviderLabel provider={w.provider} />
                  </td>
                  <td className="py-3 px-4 font-mono font-medium text-slate-900">{w.account_number}</td>
                  <td className="py-3 px-4">
                    <p className="font-medium text-slate-900">{w.account_title}</p>
                    <p className="text-slate-500">
                      {w.merchant_name}
                      {w.bank_name ? ` · ${w.bank_name}` : ''}
                    </p>
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span className="text-slate-700">{w.account_type}</span>{' '}
                    <span className={Number(w.is_active) === 1 ? 'text-emerald-700 font-semibold' : 'text-slate-400'}>
                      · {Number(w.is_active) === 1 ? 'ACTIVE' : 'PAUSED'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                    {formatBdt(w.daily_received_bdt)} / {formatBdt(w.daily_limit_bdt)}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {canManageResources && (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleToggleWalletActive(w)}
                          className="px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          {Number(w.is_active) === 1 ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditWallet(w)}
                          className="p-1.5 text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md"
                          title="Edit wallet"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteWallet(w)}
                          className="p-1.5 text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 rounded-md"
                          title="Delete wallet"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
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

      {/* Signed Webhook Delivery Log */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Signed Merchant Webhook Deliveries</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Automatic exponential retry worker · Signed with{' '}
              <span className="font-mono">X-Gateway-Signature</span>
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
                    <span
                      className={
                        d.status === 'DELIVERED' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'
                      }
                    >
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
            {[
              { label: 'Live API Key', val: issuedSecretModal.apiKey },
              { label: 'Test Sandbox API Key', val: issuedSecretModal.testApiKey },
              { label: 'API Secret (X-Api-Secret)', val: issuedSecretModal.apiSecret },
              { label: 'Webhook HMAC Secret', val: issuedSecretModal.webhookSecret },
            ]
              .filter((x) => Boolean(x.val))
              .map((item) => (
                <div key={item.label}>
                  <p className="text-xs font-medium text-slate-700 mb-1">{item.label}</p>
                  <div className="flex items-center gap-2 bg-slate-100 p-2.5 rounded-lg font-mono text-xs break-all">
                    <span className="flex-1">{item.val}</span>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(item.val!)}
                      className="p-1 text-slate-600 hover:text-slate-900"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Merchant Settings Modal */}
      {settingsMerchant && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Settings — {settingsMerchant.name}
              </h3>
              <button type="button" onClick={() => setSettingsMerchant(null)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSaveSettings} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Default Webhook URL</label>
                <input
                  type="url"
                  value={cfgWebhookUrl}
                  onChange={(e) => setCfgWebhookUrl(e.target.value)}
                  placeholder="https://merchant.bd/api/takaledger-webhook"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Auto-Verification Policy</label>
                <select
                  value={cfgAutoPolicy}
                  onChange={(e) =>
                    setCfgAutoPolicy(e.target.value as 'DETERMINISTIC_PERSONAL_PROOF' | 'STRICT_API_ONLY')
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                >
                  <option value="DETERMINISTIC_PERSONAL_PROOF">
                    Zero-TrxID Multi-Factor Auto-Settlement (Personal + Merchant)
                  </option>
                  <option value="STRICT_API_ONLY">
                    Strict Official API / Manual Review Only
                  </option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Business Phone</label>
                <input
                  type="text"
                  value={cfgPhone}
                  onChange={(e) => setCfgPhone(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Business Address</label>
                <input
                  type="text"
                  value={cfgAddress}
                  onChange={(e) => setCfgAddress(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSettingsMerchant(null)}
                  className="px-3 py-2 text-xs bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Save Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Domain Verification Modal */}
      {verifySite && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Verify Domain — {verifySite.domain}</h3>
              <button type="button" onClick={() => setVerifySite(null)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
              <p className="text-slate-500">Verification Token</p>
              <p className="font-mono font-semibold text-slate-900 break-all">
                {verifySite.verification_token || 'tl-verify-token'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Verification Method</label>
              <select
                value={verifyMethod}
                onChange={(e) =>
                  setVerifyMethod(
                    e.target.value as 'SANDBOX_CONFIRM' | 'DNS_TXT' | 'HTML_META' | 'HTTP_FILE',
                  )
                }
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              >
                <option value="SANDBOX_CONFIRM">Instant Handshake Confirmation</option>
                <option value="DNS_TXT">DNS TXT Record Check</option>
                <option value="HTML_META">HTML Meta Tag Check</option>
                <option value="HTTP_FILE">.well-known/takaledger-verify.txt</option>
              </select>
            </div>
            {verifyMsg && (
              <div className="p-2.5 text-xs bg-slate-100 border border-slate-200 rounded-lg text-slate-800">
                {verifyMsg}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setVerifySite(null)}
                className="px-3 py-2 text-xs bg-slate-100 rounded-lg"
              >
                Close
              </button>
              <button
                type="button"
                disabled={verifying}
                onClick={handleVerifyWebsite}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
              >
                {verifying ? 'Verifying...' : 'Run Ownership Check'}
              </button>
            </div>
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
                <button
                  type="button"
                  onClick={() => setShowAddMerchant(false)}
                  className="px-3 py-2 text-xs bg-slate-100 rounded-lg"
                >
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

      {/* Add / Edit Website Modal */}
      {showWebsiteModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {editingWebsite ? `Edit ${editingWebsite.domain}` : 'Add Merchant Website'}
              </h3>
              <button type="button" onClick={() => setShowWebsiteModal(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSaveWebsite} className="space-y-3">
              {user.role !== 'MERCHANT_ADMIN' && !editingWebsite && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={sMerchantId}
                    onChange={(e) => setSMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
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
                  placeholder="e.g. DaktarSerial Portal"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Domain</label>
                  <input
                    type="text"
                    required
                    disabled={!!editingWebsite}
                    value={sDomain}
                    onChange={(e) => setSDomain(e.target.value)}
                    placeholder="daktarserial.online"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">API Mode</label>
                  <select
                    value={sMode}
                    onChange={(e) => setSMode(e.target.value as 'LIVE' | 'TEST')}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="LIVE">LIVE</option>
                    <option value="TEST">TEST (Sandbox)</option>
                  </select>
                </div>
              </div>
              {!editingWebsite && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Platform</label>
                  <select
                    value={sPlatform}
                    onChange={(e) =>
                      setSPlatform(e.target.value as 'WOOCOMMERCE' | 'CUSTOM' | 'SHOPIFY' | 'LARAVEL')
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="WOOCOMMERCE">WooCommerce</option>
                    <option value="CUSTOM">Custom / Next.js / PHP API</option>
                    <option value="LARAVEL">Laravel</option>
                    <option value="SHOPIFY">Shopify</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Success Redirect URL</label>
                <input
                  type="url"
                  value={sSuccessUrl}
                  onChange={(e) => setSSuccessUrl(e.target.value)}
                  placeholder="https://daktarserial.online/payment/success"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Cancel Redirect URL</label>
                <input
                  type="url"
                  value={sCancelUrl}
                  onChange={(e) => setSCancelUrl(e.target.value)}
                  placeholder="https://daktarserial.online/payment/cancel"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Callback Webhook URL</label>
                <input
                  type="url"
                  value={sCallback}
                  onChange={(e) => setSCallback(e.target.value)}
                  placeholder="https://daktarserial.online/api/takaledger-webhook"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              {sError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{sError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowWebsiteModal(false)}
                  className="px-3 py-2 text-xs bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  {editingWebsite ? 'Save Website' : 'Register Website'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add / Edit Payment Account Modal */}
      {showAddWallet && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {editingWallet ? `Edit ${editingWallet.account_number}` : 'Add Receiving Payment Account'}
              </h3>
              <button type="button" onClick={() => setShowAddWallet(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSaveWallet} className="space-y-3">
              {user.role !== 'MERCHANT_ADMIN' && !editingWallet && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={wMerchantId}
                    onChange={(e) => setWMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provider</label>
                  <select
                    disabled={!!editingWallet}
                    value={wProvider}
                    onChange={(e) => setWProvider(e.target.value as ProviderCode)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg disabled:bg-slate-100"
                  >
                    {ALL_PROVIDERS.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.label}
                      </option>
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
                    <option value="PERSONAL">Personal</option>
                    <option value="MERCHANT">Merchant</option>
                    <option value="AGENT">Agent</option>
                    <option value="BANK_ACCOUNT">Bank Account</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Wallet / Account Number</label>
                  <input
                    type="text"
                    required
                    disabled={!!editingWallet}
                    value={wNumber}
                    onChange={(e) => setWNumber(e.target.value)}
                    placeholder="017XXXXXXXX"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Daily Limit (BDT)</label>
                  <input
                    type="number"
                    required
                    min="100"
                    value={wDailyLimit}
                    onChange={(e) => setWDailyLimit(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account Title</label>
                <input
                  type="text"
                  required
                  value={wTitle}
                  onChange={(e) => setWTitle(e.target.value)}
                  placeholder="e.g. DaktarSerial Personal bKash"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Bank Name (For Bangla QR / CellFin / Bank SMS)
                </label>
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
                <button
                  type="button"
                  onClick={() => setShowAddWallet(false)}
                  className="px-3 py-2 text-xs bg-slate-100 rounded-lg"
                >
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
