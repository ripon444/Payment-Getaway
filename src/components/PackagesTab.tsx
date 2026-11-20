import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Edit3, Plus, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import {
  ALL_PROVIDERS,
  type AdminSubscriptionOverview,
  type AuthUser,
  type ProviderCode,
  type SubscriptionPackage,
} from '../types/gateway.ts';

interface PackagesTabProps {
  user: AuthUser;
  onRefreshWorkspace: () => void;
}

export function PackagesTab({ user, onRefreshWorkspace }: PackagesTabProps) {
  const [packages, setPackages] = useState<SubscriptionPackage[]>([]);
  const [overview, setOverview] = useState<AdminSubscriptionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingPkg, setEditingPkg] = useState<SubscriptionPackage | null>(null);
  const [showPkgModal, setShowPkgModal] = useState(false);

  const [fCode, setFCode] = useState('');
  const [fName, setFName] = useState('');
  const [fTagline, setFTagline] = useState('');
  const [fMonthly, setFMonthly] = useState('990');
  const [fYearly, setFYearly] = useState('9900');
  const [fMaxWebsites, setFMaxWebsites] = useState('2');
  const [fMaxDevices, setFMaxDevices] = useState('2');
  const [fMonthlyTx, setFMonthlyTx] = useState('1500');
  const [fProviders, setFProviders] = useState<ProviderCode[]>(['BKASH', 'NAGAD', 'ROCKET', 'UPAY']);
  const [fActive, setFActive] = useState(true);
  const [savingPkg, setSavingPkg] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, sRes] = await Promise.all([
        user.role === 'SUPER_ADMIN'
          ? apiFetch<{ packages: SubscriptionPackage[] }>('/api/admin/packages')
          : apiFetch<{ packages: SubscriptionPackage[] }>('/api/packages'),
        apiFetch<AdminSubscriptionOverview>('/api/admin/subscriptions'),
      ]);
      setPackages(pRes.packages);
      setOverview(sRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load SaaS packages');
    } finally {
      setLoading(false);
    }
  }, [user.role]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function openNewPackage() {
    setEditingPkg(null);
    setFCode('');
    setFName('');
    setFTagline('');
    setFMonthly('990');
    setFYearly('9900');
    setFMaxWebsites('2');
    setFMaxDevices('2');
    setFMonthlyTx('1500');
    setFProviders(['BKASH', 'NAGAD', 'ROCKET', 'UPAY']);
    setFActive(true);
    setShowPkgModal(true);
  }

  function openEditPackage(pkg: SubscriptionPackage) {
    setEditingPkg(pkg);
    setFCode(pkg.code);
    setFName(pkg.name);
    setFTagline(pkg.tagline ?? '');
    setFMonthly(String(pkg.monthlyPriceBdt));
    setFYearly(String(pkg.yearlyPriceBdt));
    setFMaxWebsites(String(pkg.maxWebsites));
    setFMaxDevices(String(pkg.maxDevices));
    setFMonthlyTx(String(pkg.monthlyTxLimit));
    setFProviders(pkg.allowedProviders);
    setFActive(pkg.isActive);
    setShowPkgModal(true);
  }

  function toggleProvider(code: ProviderCode) {
    setFProviders((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  }

  async function handleSavePackage(e: React.FormEvent) {
    e.preventDefault();
    setSavingPkg(true);
    setError(null);
    try {
      const body = {
        code: fCode,
        name: fName,
        tagline: fTagline || null,
        monthlyPriceBdt: Number(fMonthly),
        yearlyPriceBdt: Number(fYearly),
        maxWebsites: Number(fMaxWebsites),
        maxDevices: Number(fMaxDevices),
        monthlyTxLimit: Number(fMonthlyTx),
        allowedProviders: fProviders,
        isActive: fActive,
      };
      if (editingPkg) {
        await apiFetch(`/api/admin/packages/${editingPkg.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch('/api/admin/packages', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      setShowPkgModal(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save package');
    } finally {
      setSavingPkg(false);
    }
  }

  async function handleMerchantStatusAction(merchantId: string, status: 'ACTIVE' | 'SUSPENDED', extendDays?: number) {
    await apiFetch(`/api/admin/merchants/${merchantId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, extendDays }),
    });
    await loadData();
    onRefreshWorkspace();
  }

  const stats = overview?.revenueStats ?? {
    total_revenue_bdt: 0,
    paid_invoices: 0,
    active_subs: 0,
    trial_subs: 0,
    expired_subs: 0,
    mrr_bdt: 0,
  };

  return (
    <div className="space-y-6">
      {/* SaaS Revenue KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Monthly Recurring Revenue (MRR)</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {formatBdt(stats.mrr_bdt)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            <span className="font-mono">{stats.active_subs}</span> active paid plans
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Collected Subscription Revenue</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
            {formatBdt(stats.total_revenue_bdt)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            <span className="font-mono">{stats.paid_invoices}</span> paid invoices
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Merchants in 14-Day Trial</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-amber-700">
            {stats.trial_subs}
          </p>
          <p className="mt-1 text-xs text-slate-500">Self-service signups</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Expired Subscriptions</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-rose-700">
            {stats.expired_subs}
          </p>
          <p className="mt-1 text-xs text-slate-500">Auto-paused from creating new TX</p>
        </div>
      </div>

      {error && (
        <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
          {error}
        </div>
      )}

      {/* Commercial Packages Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Commercial Subscription Packages</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Define pricing, website limits, Android device quotas, monthly transaction caps, and supported channels
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            {user.role === 'SUPER_ADMIN' && (
              <button
                type="button"
                onClick={openNewPackage}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Package</span>
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Package</th>
                <th className="py-2.5 px-4 text-right">Monthly</th>
                <th className="py-2.5 px-4 text-right">Yearly</th>
                <th className="py-2.5 px-4 text-right">Sites / Devices</th>
                <th className="py-2.5 px-4 text-right">Monthly TX Limit</th>
                <th className="py-2.5 px-4">Providers</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {packages.map((pkg) => (
                <tr key={pkg.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">
                      {pkg.name} <span className="font-mono text-slate-500">({pkg.code})</span>
                    </p>
                    <p className="text-slate-500">{pkg.tagline}</p>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                    {formatBdt(pkg.monthlyPriceBdt)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {formatBdt(pkg.yearlyPriceBdt)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {pkg.maxWebsites} sites · {pkg.maxDevices} dev
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                    {pkg.monthlyTxLimit.toLocaleString()}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600">
                    {pkg.allowedProviders.length} channels
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span className={pkg.isActive ? 'text-emerald-700 font-medium' : 'text-slate-400'}>
                      {pkg.isActive ? 'ACTIVE' : 'DISABLED'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    {user.role === 'SUPER_ADMIN' && (
                      <button
                        type="button"
                        onClick={() => openEditPackage(pkg)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Merchant Subscriptions Management */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Merchant Subscriptions & Quota Controls</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Monitor merchant billing periods, usage meters, suspend overdue tenants, or grant +30 day extensions
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Plan / Cycle</th>
                <th className="py-2.5 px-4">Sub Status</th>
                <th className="py-2.5 px-4 text-right">TX Usage</th>
                <th className="py-2.5 px-4">Period End</th>
                <th className="py-2.5 px-4 text-right">Admin Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {(overview?.subscriptions ?? []).map((sub) => (
                <tr key={sub.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{sub.merchant_name}</p>
                    <p className="text-slate-500">{sub.contact_email} · Account: {sub.merchant_status}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">
                    {sub.package_name} ({sub.billing_cycle})
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span
                      className={
                        sub.status === 'ACTIVE'
                          ? 'text-emerald-700 font-medium'
                          : sub.status === 'TRIAL'
                            ? 'text-teal-700 font-medium'
                            : 'text-rose-700 font-medium'
                      }
                    >
                      {sub.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                    {sub.tx_used_current_period} / {sub.monthly_tx_limit}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                    {formatTimestamp(sub.current_period_end)}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {user.role === 'SUPER_ADMIN' && (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleMerchantStatusAction(sub.merchant_id, 'ACTIVE', 30)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          <span>+30d Active</span>
                        </button>
                        {sub.merchant_status === 'ACTIVE' ? (
                          <button
                            type="button"
                            onClick={() => handleMerchantStatusAction(sub.merchant_id, 'SUSPENDED')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-md"
                          >
                            <ShieldAlert className="h-3 w-3" />
                            <span>Suspend</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleMerchantStatusAction(sub.merchant_id, 'ACTIVE')}
                            className="px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md"
                          >
                            Unsuspend
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Paid Invoices Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Subscription Billing Invoices</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Invoice #</th>
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Package</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Method / Status</th>
                <th className="py-2.5 px-4">Paid At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {(overview?.invoices ?? []).map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4 font-mono font-medium text-slate-900">{inv.invoice_number}</td>
                  <td className="py-3 px-4 text-slate-700">{inv.merchant_name}</td>
                  <td className="py-3 px-4 font-mono text-slate-700">
                    {inv.package_name} ({inv.billing_cycle})
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                    {formatBdt(inv.amount_bdt)}
                  </td>
                  <td className="py-3 px-4 font-mono text-emerald-700">
                    {inv.payment_method} · {inv.status}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                    {formatTimestamp(inv.paid_at || inv.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Package Modal */}
      {showPkgModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                {editingPkg ? `Edit ${editingPkg.name}` : 'Create Commercial Package'}
              </h3>
              <button type="button" onClick={() => setShowPkgModal(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleSavePackage} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Package Code</label>
                  <input
                    type="text"
                    required
                    disabled={!!editingPkg}
                    value={fCode}
                    onChange={(e) => setFCode(e.target.value.toUpperCase())}
                    placeholder="GROWTH_PRO"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={fName}
                    onChange={(e) => setFName(e.target.value)}
                    placeholder="Growth Pro"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tagline</label>
                <input
                  type="text"
                  value={fTagline}
                  onChange={(e) => setFTagline(e.target.value)}
                  placeholder="For multi-store e-commerce merchants"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Monthly Price (BDT)</label>
                  <input
                    type="number"
                    required
                    min="0"
                    value={fMonthly}
                    onChange={(e) => setFMonthly(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Yearly Price (BDT)</label>
                  <input
                    type="number"
                    required
                    min="0"
                    value={fYearly}
                    onChange={(e) => setFYearly(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Max Websites</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={fMaxWebsites}
                    onChange={(e) => setFMaxWebsites(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Max Devices</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={fMaxDevices}
                    onChange={(e) => setFMaxDevices(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Monthly TX Cap</label>
                  <input
                    type="number"
                    required
                    min="50"
                    value={fMonthlyTx}
                    onChange={(e) => setFMonthlyTx(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Allowed Payment Channels</label>
                <div className="flex flex-wrap gap-2">
                  {ALL_PROVIDERS.map((p) => (
                    <button
                      key={p.code}
                      type="button"
                      onClick={() => toggleProvider(p.code)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md border ${
                        fProviders.includes(p.code)
                          ? 'bg-teal-50 border-teal-700 text-teal-900'
                          : 'bg-white border-slate-200 text-slate-600'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={fActive}
                  onChange={(e) => setFActive(e.target.checked)}
                />
                <span>Package Active on Public Pricing Matrix</span>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPkgModal(false)}
                  className="px-3.5 py-2 text-xs bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPkg}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {savingPkg ? 'Saving...' : 'Save Package'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
