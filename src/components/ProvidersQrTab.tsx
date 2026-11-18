import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Plus, QrCode, RefreshCw, X } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { AuthUser, BankSmsTemplateRow, ProviderConfigRow } from '../types/gateway.ts';
import { ProviderLabel } from './StatusText.tsx';

interface ProvidersQrTabProps {
  user: AuthUser;
}

export function ProvidersQrTab({ user }: ProvidersQrTabProps) {
  const [providers, setProviders] = useState<ProviderConfigRow[]>([]);
  const [templates, setTemplates] = useState<BankSmsTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAddTpl, setShowAddTpl] = useState(false);
  const [bankName, setBankName] = useState('');
  const [senderId, setSenderId] = useState('');
  const [providerCode, setProviderCode] = useState<'BANK_SMS' | 'BANGLA_QR'>('BANK_SMS');
  const [sampleSms, setSampleSms] = useState('');
  const [amountRegex, setAmountRegex] = useState('(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)');
  const [trxRegex, setTrxRegex] = useState('(?:Ref|TrxID|TxnID)\\s*[:#-]?\\s*([A-Z0-9-]{6,20})');
  const [accountRegex, setAccountRegex] = useState('A\\/C\\s*([*\\d]{4,18})');
  const [banglaQrCapable, setBanglaQrCapable] = useState(true);
  const [tplError, setTplError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        providers: ProviderConfigRow[];
        templates: BankSmsTemplateRow[];
      }>('/api/providers');
      setProviders(res.providers);
      setTemplates(res.templates);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleToggleProvider(code: string, currentEnabled: number) {
    await apiFetch(`/api/providers/${code}`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled: currentEnabled !== 1 }),
    });
    await loadData();
  }

  async function handleCreateTemplate(e: React.FormEvent) {
    e.preventDefault();
    setTplError(null);
    try {
      await apiFetch('/api/bank-templates', {
        method: 'POST',
        body: JSON.stringify({
          bankName,
          senderId,
          providerCode,
          sampleSms,
          amountRegex,
          trxRegex,
          accountRegex,
          banglaQrCapable,
        }),
      });
      setShowAddTpl(false);
      setBankName('');
      setSenderId('');
      setSampleSms('');
      await loadData();
    } catch (err) {
      setTplError(err instanceof Error ? err.message : 'Failed to save bank SMS template');
    }
  }

  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const canAddTemplate = isSuperAdmin || user.role === 'OPERATIONS';

  return (
    <div className="space-y-6">
      {/* Provider Reliability & Capability Matrix */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Payment Provider & Bangla QR Reliability Matrix
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Personal/Merchant account support, official API verification support, and Bangla QR notification correlation reliability
            </p>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Provider</th>
                <th className="py-2.5 px-4">Account Types</th>
                <th className="py-2.5 px-4">API Settlement</th>
                <th className="py-2.5 px-4">Bangla QR Match</th>
                <th className="py-2.5 px-4">Reliability Notes</th>
                <th className="py-2.5 px-4 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {providers.map((p) => (
                <tr key={p.provider_code} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <ProviderLabel provider={p.provider_code} />
                    <p className="text-slate-500 mt-0.5">{p.display_name}</p>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700">
                    {[p.supports_personal ? 'Personal' : null, p.supports_merchant ? 'Merchant' : null]
                      .filter(Boolean)
                      .join(' / ')}
                  </td>
                  <td className="py-3 px-4">
                    <span className={p.supports_api_verification ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                      {p.supports_api_verification ? 'Merchant API Supported' : 'Manual Statement Required'}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={p.bangla_qr_reliable ? 'inline-flex items-center gap-1 text-emerald-700 font-medium' : 'text-slate-500'}>
                      {p.bangla_qr_reliable === 1 && <QrCode className="h-3.5 w-3.5" />}
                      {p.bangla_qr_reliable ? 'Correlated via SMS/App' : 'Standard MFS'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-600 max-w-md">{p.reliability_notes}</td>
                  <td className="py-3 px-4 text-right">
                    {isSuperAdmin ? (
                      <button
                        type="button"
                        onClick={() => handleToggleProvider(p.provider_code, p.is_enabled)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md border ${
                          p.is_enabled === 1
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                            : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
                        }`}
                      >
                        {p.is_enabled === 1 ? 'Enabled' : 'Disabled'}
                      </button>
                    ) : (
                      <span className={p.is_enabled === 1 ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                        {p.is_enabled === 1 ? 'Enabled' : 'Disabled'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bank SMS & Bangla QR Template Registry */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Bank SMS & Bangla QR Parser Templates ({templates.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Dynamic regex rules evaluated by bankSmsParser & banglaQrParser when bank alerts arrive from Android devices
            </p>
          </div>
          {canAddTemplate && (
            <button
              type="button"
              onClick={() => setShowAddTpl(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Bank SMS Format</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Bank / Institution</th>
                <th className="py-2.5 px-4">SMS Sender ID</th>
                <th className="py-2.5 px-4">Bangla QR</th>
                <th className="py-2.5 px-4">Sample SMS Format</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4 font-medium text-slate-900">{t.bank_name}</td>
                  <td className="py-3 px-4 font-mono text-slate-800">{t.sender_id}</td>
                  <td className="py-3 px-4">
                    {t.bangla_qr_capable === 1 ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Supported
                      </span>
                    ) : (
                      <span className="text-slate-500">Credit Alert</span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600 max-w-lg truncate" title={t.sample_sms}>
                    {t.sample_sms}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Bank SMS Template Modal */}
      {showAddTpl && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Register Bank SMS Format</h3>
              <button type="button" onClick={() => setShowAddTpl(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateTemplate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Bank Name</label>
                  <input
                    type="text"
                    required
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g. Eastern Bank PLC (EBL)"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">SMS Sender ID</label>
                  <input
                    type="text"
                    required
                    value={senderId}
                    onChange={(e) => setSenderId(e.target.value)}
                    placeholder="e.g. EBL"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Channel Provider</label>
                  <select
                    value={providerCode}
                    onChange={(e) => setProviderCode(e.target.value as 'BANK_SMS' | 'BANGLA_QR')}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="BANK_SMS">BANK_SMS</option>
                    <option value="BANGLA_QR">BANGLA_QR</option>
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={banglaQrCapable}
                      onChange={(e) => setBanglaQrCapable(e.target.checked)}
                    />
                    <span>Supports Bangla QR matching</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Sample Bank SMS</label>
                <textarea
                  rows={2}
                  required
                  value={sampleSms}
                  onChange={(e) => setSampleSms(e.target.value)}
                  placeholder="EBL: Your A/C 1041****22 credited with BDT 2,000.00 via BanglaQR. Ref: EBLQR8812"
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Amount Regex</label>
                <input
                  type="text"
                  value={amountRegex}
                  onChange={(e) => setAmountRegex(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">TrxID / Ref Regex</label>
                  <input
                    type="text"
                    value={trxRegex}
                    onChange={(e) => setTrxRegex(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Account Regex</label>
                  <input
                    type="text"
                    value={accountRegex}
                    onChange={(e) => setAccountRegex(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              {tplError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{tplError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddTpl(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Save Template
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
