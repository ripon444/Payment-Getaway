import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import type {
  ApkInfo,
  AuthUser,
  MerchantEntitlements,
  MerchantRow,
  SubscriptionInvoice,
  SubscriptionPackage,
} from '../types/gateway.ts';

interface SubscriptionApkTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
  onNavigateDevices: () => void;
  onRefreshWorkspace: () => void;
}

export function SubscriptionApkTab({
  user,
  merchants,
  onNavigateDevices,
  onRefreshWorkspace,
}: SubscriptionApkTabProps) {
  const merchantId = user.merchantId ?? merchants[0]?.id ?? '';
  const [entitlements, setEntitlements] = useState<MerchantEntitlements | null>(null);
  const [invoices, setInvoices] = useState<SubscriptionInvoice[]>([]);
  const [packages, setPackages] = useState<SubscriptionPackage[]>([]);
  const [apkInfo, setApkInfo] = useState<ApkInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [paymentMethod, setPaymentMethod] = useState('BKASH');
  const [subscribingCode, setSubscribingCode] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    try {
      const [subRes, apkRes] = await Promise.all([
        apiFetch<{
          entitlements: MerchantEntitlements;
          invoices: SubscriptionInvoice[];
          availablePackages: SubscriptionPackage[];
        }>(`/api/merchant/subscription?merchantId=${encodeURIComponent(merchantId)}`),
        apiFetch<ApkInfo>('/api/merchant/apk-info'),
      ]);
      setEntitlements(subRes.entitlements);
      setInvoices(subRes.invoices);
      setPackages(subRes.availablePackages);
      setApkInfo(apkRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load subscription status');
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSubscribe(pkg: SubscriptionPackage) {
    setSubscribingCode(pkg.code);
    setMsg(null);
    setError(null);
    try {
      const res = await apiFetch<{
        invoiceNumber: string;
        amountBdt: number;
        packageName: string;
      }>('/api/merchant/subscription', {
        method: 'POST',
        body: JSON.stringify({
          merchantId,
          packageId: pkg.id,
          billingCycle,
          paymentMethod,
        }),
      });
      setMsg(
        `Activated ${res.packageName} (${billingCycle}) — Invoice ${res.invoiceNumber} (${formatBdt(res.amountBdt)}) recorded.`,
      );
      await loadData();
      onRefreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscription activation failed');
    } finally {
      setSubscribingCode(null);
    }
  }

  function pct(used: number, max: number) {
    if (!max || max <= 0) return 0;
    return Math.min(100, Math.round((used / max) * 100));
  }

  return (
    <div className="space-y-6">
      {entitlements && !entitlements.hasActiveSubscription && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-rose-700 shrink-0 mt-0.5" />
          <div className="text-xs text-rose-900 space-y-1">
            <p className="font-semibold">
              Subscription Inactive / Expired ({entitlements.subscriptionStatus})
            </p>
            <p>
              {entitlements.reasonIfBlocked ||
                'New payment session creation is paused until you renew your subscription below. All historical transactions and CSV/JSON financial exports remain accessible.'}
            </p>
          </div>
        </div>
      )}

      {msg && (
        <div className="p-3.5 text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg">
          {msg}
        </div>
      )}
      {error && (
        <div className="p-3.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
          {error}
        </div>
      )}

      {/* Active Subscription & Quota Meters */}
      {entitlements && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs font-medium text-slate-500">Current Commercial Plan</p>
              <div className="flex items-center gap-2.5 mt-1">
                <h2 className="text-xl font-semibold text-slate-900">{entitlements.packageName}</h2>
                <span
                  className={`text-xs font-mono font-semibold ${
                    entitlements.hasActiveSubscription ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {entitlements.subscriptionStatus}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {entitlements.daysRemaining} day(s) remaining · Renewal Date:{' '}
                <span className="font-mono">{formatTimestamp(entitlements.currentPeriodEnd)}</span>
              </p>
            </div>

            <button
              type="button"
              onClick={loadData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg self-start"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh Quotas</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 font-medium">Connected Websites</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">
                  {entitlements.usedWebsites} / {entitlements.maxWebsites}
                </span>
              </div>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal-700"
                  style={{ width: `${pct(entitlements.usedWebsites, entitlements.maxWebsites)}%` }}
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 font-medium">Paired Android Devices</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">
                  {entitlements.usedDevices} / {entitlements.maxDevices}
                </span>
              </div>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal-700"
                  style={{ width: `${pct(entitlements.usedDevices, entitlements.maxDevices)}%` }}
                />
              </div>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 font-medium">Monthly Payment Sessions</span>
                <span className="font-mono tabular-nums font-semibold text-slate-900">
                  {entitlements.usedTxCurrentPeriod} / {entitlements.monthlyTxLimit}
                </span>
              </div>
              <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-teal-700"
                  style={{
                    width: `${pct(entitlements.usedTxCurrentPeriod, entitlements.monthlyTxLimit)}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-600">
            Enabled Providers: <span className="font-mono text-slate-900">{entitlements.allowedProviders.join(', ')}</span>
          </p>
        </div>
      )}

      {/* Upgrade or Renew Package */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Upgrade or Renew Commercial Package</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Choose Monthly or Yearly billing and activate immediately
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="BKASH">Pay via bKash</option>
              <option value="NAGAD">Pay via Nagad</option>
              <option value="ROCKET">Pay via Rocket</option>
              <option value="BANGLA_QR">Pay via Bangla QR</option>
            </select>

            <div className="inline-flex bg-slate-100 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setBillingCycle('MONTHLY')}
                className={`px-3 py-1 text-xs font-medium rounded-md ${
                  billingCycle === 'MONTHLY' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle('YEARLY')}
                className={`px-3 py-1 text-xs font-medium rounded-md ${
                  billingCycle === 'YEARLY' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Yearly
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {packages.map((pkg) => {
            const isCurrent = entitlements?.packageCode === pkg.code && entitlements.subscriptionStatus === 'ACTIVE';
            const price = billingCycle === 'YEARLY' ? pkg.yearlyPriceBdt : pkg.monthlyPriceBdt;
            return (
              <div
                key={pkg.id}
                className={`border rounded-xl p-4 flex flex-col justify-between ${
                  isCurrent ? 'border-teal-700 bg-teal-50/30' : 'border-slate-200 bg-white'
                }`}
              >
                <div className="space-y-2.5">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{pkg.name}</h3>
                    <p className="text-xs text-slate-500">{pkg.tagline}</p>
                  </div>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {formatBdt(price)}
                  </p>
                  <ul className="space-y-1 text-xs text-slate-600">
                    <li className="flex items-center gap-1.5">
                      <Check className="h-3 w-3 text-teal-700" />
                      <span>{pkg.maxWebsites} Websites</span>
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Check className="h-3 w-3 text-teal-700" />
                      <span>{pkg.maxDevices} Android Devices</span>
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Check className="h-3 w-3 text-teal-700" />
                      <span>{pkg.monthlyTxLimit.toLocaleString()} TX/mo</span>
                    </li>
                  </ul>
                </div>

                <button
                  type="button"
                  disabled={subscribingCode === pkg.code}
                  onClick={() => handleSubscribe(pkg)}
                  className={`mt-4 w-full py-2 px-3 text-xs font-medium rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 ${
                    isCurrent
                      ? 'bg-slate-900 text-white hover:bg-slate-800'
                      : 'bg-teal-700 text-white hover:bg-teal-800'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>
                    {subscribingCode === pkg.code
                      ? 'Activating...'
                      : isCurrent
                        ? 'Renew Plan'
                        : 'Select & Activate'}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Android Agent APK v2.1.0 Hub */}
      {apkInfo && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 bg-teal-50 border border-teal-200 rounded-lg text-teal-700">
                <Smartphone className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {apkInfo.appName} (v{apkInfo.latestVersion})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Package <span className="font-mono">{apkInfo.packageId}</span> · Android {apkInfo.minAndroidSdk}+ · QR Pairing & Dual-SIM Auto-Sync
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onNavigateDevices}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Generate Device Pairing QR</span>
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2 text-xs">
              <p className="font-semibold text-slate-800">Gateway Endpoints Configured Automatically via QR</p>
              {[
                { label: 'Base URL', val: apkInfo.gatewayBaseUrl },
                { label: 'Pairing Endpoint', val: apkInfo.endpoints.pair },
                { label: 'Ingest Endpoint', val: apkInfo.endpoints.ingest },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-500">{row.label}</p>
                    <p className="font-mono text-slate-900 truncate">{row.val}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(row.val);
                      setCopiedUrl(row.label);
                      setTimeout(() => setCopiedUrl(null), 1500);
                    }}
                    className="p-1.5 text-slate-500 hover:text-slate-900 shrink-0"
                  >
                    {copiedUrl === row.label ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ))}
            </div>

            <div className="space-y-2 text-xs">
              <p className="font-semibold text-slate-800">On-Device Security & Isolation</p>
              <ul className="space-y-1.5 text-slate-600">
                {apkInfo.securityFeatures.map((feat) => (
                  <li key={feat} className="flex items-start gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 text-teal-700 shrink-0 mt-0.5" />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
              <p className="pt-2 text-slate-500 font-mono text-[11px]">{apkInfo.buildGuide}</p>
            </div>
          </div>
        </div>
      )}

      {/* Merchant Invoices */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Your Billing Invoices</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Invoice #</th>
                <th className="py-2.5 px-4">Package</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Method</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Paid At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    No paid invoices yet (currently on trial or free plan).
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4 font-mono font-medium text-slate-900">{inv.invoice_number}</td>
                    <td className="py-3 px-4 font-mono text-slate-700">
                      {inv.package_name} ({inv.billing_cycle})
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                      {formatBdt(inv.amount_bdt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-700">{inv.payment_method}</td>
                    <td className="py-3 px-4 font-mono text-emerald-700 font-medium">{inv.status}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                      {formatTimestamp(inv.paid_at || inv.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
