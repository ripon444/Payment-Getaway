import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Plus, QrCode, Search, ShieldCheck, X } from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import {
  ALL_PROVIDERS,
  type AuthUser,
  type MerchantRow,
  type PaymentIntentRow,
  type ProviderCode,
} from '../types/gateway.ts';
import { PaymentStatusLabel, ProviderLabel } from './StatusText.tsx';

interface PaymentDetailResponse {
  payment: PaymentIntentRow;
  candidates: Array<{
    id: string;
    confidence_score: number;
    match_reasons_json: string;
    status: string;
    raw_body_redacted: string;
    parsed_trx_id: string | null;
    parsed_amount_bdt: number | null;
    parsed_sender_phone: string | null;
    parsed_receiver_account: string | null;
    parsed_bank_name: string | null;
    parser_module: string | null;
    source_channel: string | null;
    device_name: string | null;
    received_at: string;
  }>;
  verifications: Array<{
    id: string;
    verification_source: string;
    provider_trx_id: string;
    verified_amount_bdt: number;
    documentary_evidence_ref: string;
    verifier_name: string | null;
    verifier_email: string | null;
    notes: string | null;
    decision: string;
    verified_at: string;
  }>;
  webhooks: Array<{
    id: string;
    event_type: string;
    status: string;
    http_status: number | null;
    attempt_count: number;
    created_at: string;
  }>;
}

interface PaymentsTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
  selectedPaymentId: string | null;
  onSelectPayment: (id: string | null) => void;
  onDataChanged: () => void;
}

export function PaymentsTab({
  user,
  merchants,
  selectedPaymentId,
  onSelectPayment,
  onDataChanged,
}: PaymentsTabProps) {
  const [payments, setPayments] = useState<PaymentIntentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [providerFilter, setProviderFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [detail, setDetail] = useState<PaymentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [verifyTrxId, setVerifyTrxId] = useState('');
  const [verifyAmount, setVerifyAmount] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [verifyNotes, setVerifyNotes] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newMerchantId, setNewMerchantId] = useState(user.merchantId ?? merchants[0]?.id ?? '');
  const [newProvider, setNewProvider] = useState<ProviderCode>('BKASH');
  const [newAccountMode, setNewAccountMode] = useState('MERCHANT');
  const [newAmount, setNewAmount] = useState('1500');
  const [newOrderId, setNewOrderId] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!newMerchantId && (user.merchantId || merchants.length > 0)) {
      setNewMerchantId(user.merchantId ?? merchants[0]?.id ?? '');
    }
  }, [merchants, newMerchantId, user.merchantId]);

  const loadPayments = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (providerFilter !== 'ALL') qs.set('provider', providerFilter);
      if (searchQuery.trim()) qs.set('q', searchQuery.trim());
      const res = await apiFetch<{ payments: PaymentIntentRow[] }>(`/api/payments?${qs.toString()}`);
      setPayments(res.payments);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, providerFilter, searchQuery]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setVerifyError(null);
    try {
      const res = await apiFetch<PaymentDetailResponse>(`/api/payments/${id}`);
      setDetail(res);
      setVerifyTrxId(
        res.payment.submitted_trx_id || res.candidates[0]?.parsed_trx_id || '',
      );
      setVerifyAmount(String(res.payment.amount_bdt));
      setEvidenceRef('');
      setVerifyNotes('');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPaymentId) {
      loadDetail(selectedPaymentId);
    } else {
      setDetail(null);
    }
  }, [selectedPaymentId, loadDetail]);

  async function handleManualVerify(decision: 'VERIFIED' | 'REJECTED') {
    if (!detail) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      await apiFetch(`/api/payments/${detail.payment.id}/verify-manual`, {
        method: 'POST',
        body: JSON.stringify({
          providerTrxId: verifyTrxId,
          verifiedAmountBdt: Number(verifyAmount),
          documentaryEvidenceRef: evidenceRef,
          notes: verifyNotes,
          decision,
        }),
      });
      await loadDetail(detail.payment.id);
      await loadPayments();
      onDataChanged();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifyBusy(false);
    }
  }

  async function handleProviderVerify() {
    if (!detail) return;
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      await apiFetch(`/api/payments/${detail.payment.id}/verify-provider`, {
        method: 'POST',
        body: JSON.stringify({ providerTrxId: verifyTrxId }),
      });
      await loadDetail(detail.payment.id);
      await loadPayments();
      onDataChanged();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Provider verification error');
    } finally {
      setVerifyBusy(false);
    }
  }

  async function handleCreatePayment(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    try {
      const res = await apiFetch<{ id: string }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          merchantId: newMerchantId,
          provider: newProvider,
          accountMode: newAccountMode,
          amountBdt: Number(newAmount),
          merchantOrderId: newOrderId.trim() || `ORD-${Date.now().toString().slice(-6)}`,
          customerName: newCustomerName.trim() || null,
          customerPhone: newCustomerPhone.trim() || null,
        }),
      });
      setShowCreate(false);
      setNewOrderId('');
      setNewCustomerName('');
      setNewCustomerPhone('');
      await loadPayments();
      onDataChanged();
      onSelectPayment(res.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create payment intent');
    }
  }

  const canManualVerify = user.role === 'SUPER_ADMIN' || user.role === 'FINANCE_REVIEWER';

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search order ID, TrxID, phone..."
              className="pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg w-60 focus:outline-none focus:bg-white focus:border-teal-700"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-teal-700"
          >
            <option value="ALL">All 8 Statuses</option>
            <option value="PENDING">PENDING</option>
            <option value="DETECTED">DETECTED</option>
            <option value="MATCHED">MATCHED</option>
            <option value="REVIEW_REQUIRED">REVIEW_REQUIRED</option>
            <option value="VERIFIED">VERIFIED</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="FAILED">FAILED</option>
            <option value="EXPIRED">EXPIRED</option>
          </select>

          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-teal-700"
          >
            <option value="ALL">All 7 Payment Methods</option>
            {ALL_PROVIDERS.map((p) => (
              <option key={p.code} value={p.code}>{p.label}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="h-4 w-4" />
          <span>Create Payment Session</span>
        </button>
      </div>

      {/* Payments Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Order / Reference</th>
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Method</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Submitted TrxID</th>
                <th className="py-2.5 px-4">Confidence</th>
                <th className="py-2.5 px-4">Lifecycle Status</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-xs text-slate-500">
                    Loading payment sessions...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-xs text-slate-500">
                    No payment sessions match the active filters.
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr
                    key={p.id}
                    className={`hover:bg-slate-50/80 transition-colors cursor-pointer ${
                      selectedPaymentId === p.id ? 'bg-teal-50/40' : ''
                    }`}
                    onClick={() => onSelectPayment(p.id)}
                  >
                    <td className="py-3 px-4">
                      <p className="font-mono text-xs font-medium text-slate-900">{p.merchant_order_id}</p>
                      <p className="font-mono text-xs text-slate-500">Ref: {p.reference_code}</p>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">{p.merchant_name}</td>
                    <td className="py-3 px-4">
                      <ProviderLabel provider={p.provider} />
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                      {formatBdt(p.amount_bdt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700">
                      {p.submitted_trx_id || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-700">
                      {p.match_confidence !== null ? `${p.match_confidence}%` : '—'}
                    </td>
                    <td className="py-3 px-4">
                      <PaymentStatusLabel status={p.status} />
                    </td>
                    <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-2">
                        <a
                          href={`/?checkout=${p.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
                        >
                          <span>Checkout</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <button
                          type="button"
                          onClick={() => onSelectPayment(p.id)}
                          className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md whitespace-nowrap"
                        >
                          Inspect
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment Inspector Panel */}
      {selectedPaymentId && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs text-slate-500 font-mono">Payment ID · {selectedPaymentId}</p>
              <h3 className="text-lg font-semibold text-slate-900 mt-1">
                {detail?.payment.merchant_order_id ?? 'Loading...'}
              </h3>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`/?checkout=${selectedPaymentId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
              >
                <span>Open Customer Checkout</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                onClick={() => onSelectPayment(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
                aria-label="Close inspector"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {detailLoading || !detail ? (
            <p className="text-xs text-slate-500 py-6">Loading verification & candidate details...</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left: Evidence */}
              <div className="lg:col-span-7 space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <div>
                    <p className="text-xs text-slate-500">Method</p>
                    <div className="mt-1"><ProviderLabel provider={detail.payment.provider} /></div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Expected Amount</p>
                    <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-slate-900">
                      {formatBdt(detail.payment.amount_bdt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Customer TrxID</p>
                    <p className="mt-1 text-xs font-mono text-slate-900">
                      {detail.payment.submitted_trx_id || 'Not submitted'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Current State</p>
                    <div className="mt-1"><PaymentStatusLabel status={detail.payment.status} /></div>
                  </div>
                </div>

                {detail.payment.bangla_qr_string && (
                  <div className="p-3.5 bg-teal-50/60 border border-teal-200 rounded-lg space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                      <QrCode className="h-3.5 w-3.5" />
                      <span>EMVCo Bangla QR Payload</span>
                    </div>
                    <p className="text-xs font-mono text-teal-900 break-all">
                      {detail.payment.bangla_qr_string}
                    </p>
                  </div>
                )}

                <div>
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    Matched Android SMS / Notification Candidates ({detail.candidates.length})
                  </h4>
                  {detail.candidates.length === 0 ? (
                    <p className="text-xs text-slate-500 p-4 border border-slate-200 rounded-lg">
                      No Android notification or SMS candidates linked yet.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {detail.candidates.map((cand) => {
                        const reasons: string[] = JSON.parse(cand.match_reasons_json || '[]');
                        return (
                          <div key={cand.id} className="p-3.5 border border-slate-200 rounded-lg space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                              <span className="font-medium text-slate-900">
                                {cand.device_name || 'Android Device'} · {cand.source_channel || 'NOTIFICATION'} ·{' '}
                                {cand.parser_module || 'parser'} · Score {cand.confidence_score}%
                              </span>
                              <span className="font-mono text-slate-500">{formatTimestamp(cand.received_at)}</span>
                            </div>
                            <p className="text-xs font-mono text-slate-700 bg-slate-50 p-2 rounded">
                              {cand.raw_body_redacted}
                            </p>
                            <p className="text-xs text-slate-500">
                              Signals: {reasons.join(' · ')}
                              {cand.parsed_bank_name ? ` · Bank: ${cand.parsed_bank_name}` : ''}
                              {cand.parsed_receiver_account ? ` · Receiver: ${cand.parsed_receiver_account}` : ''}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-slate-700 mb-2">
                    Authoritative Verification Records ({detail.verifications.length})
                  </h4>
                  {detail.verifications.length === 0 ? (
                    <p className="text-xs text-slate-500 p-3.5 border border-slate-200 rounded-lg">
                      No authoritative verification recorded yet. SMS/notification candidates alone never set SUCCESS.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {detail.verifications.map((v) => (
                        <div key={v.id} className="p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-lg text-xs space-y-1">
                          <div className="flex items-center justify-between font-medium text-emerald-900">
                            <span className="inline-flex items-center gap-1.5">
                              <CheckCircle2 className="h-4 w-4" />
                              {v.verification_source} · {v.decision}
                            </span>
                            <span className="font-mono">{formatTimestamp(v.verified_at)}</span>
                          </div>
                          <p className="font-mono text-slate-800">
                            TrxID: {v.provider_trx_id} · Amount: {formatBdt(v.verified_amount_bdt)}
                          </p>
                          <p className="text-slate-700">
                            Documentary Evidence Ref: <span className="font-mono font-medium">{v.documentary_evidence_ref}</span>
                          </p>
                          {v.notes && <p className="text-slate-600">Notes: {v.notes}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Verification Controls */}
              <div className="lg:col-span-5 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2 text-slate-900">
                  <ShieldCheck className="h-4 w-4 text-teal-700" />
                  <h4 className="text-sm font-semibold">Settlement Verification</h4>
                </div>

                {detail.payment.status === 'SUCCESS' ? (
                  <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900">
                    This payment is verified and settled (SUCCESS). Duplicate TrxID protection is locked for {detail.payment.submitted_trx_id}.
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Verify via Official Provider API (requires merchant API credentials in .env) or record Documented Manual Finance Verification with an independent statement reference.
                    </p>

                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Provider TrxID / Reference
                        </label>
                        <input
                          type="text"
                          value={verifyTrxId}
                          onChange={(e) => setVerifyTrxId(e.target.value.toUpperCase())}
                          placeholder="e.g. BKH9X4M21Q"
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                      </div>

                      <button
                        type="button"
                        disabled={verifyBusy || !verifyTrxId}
                        onClick={handleProviderVerify}
                        className="w-full py-2 px-3 text-xs font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Verify via Official {detail.payment.provider} API
                      </button>
                    </div>

                    <div className="pt-4 border-t border-slate-200 space-y-3">
                      <p className="text-xs font-semibold text-slate-800">
                        Documented Manual Finance Verification
                      </p>

                      {!canManualVerify ? (
                        <p className="text-xs text-amber-700">
                          Requires SUPER_ADMIN or FINANCE_REVIEWER role to approve final settlement.
                        </p>
                      ) : (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Verified Amount (BDT)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              value={verifyAmount}
                              onChange={(e) => setVerifyAmount(e.target.value)}
                              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Documentary Evidence Reference (Mandatory)
                            </label>
                            <input
                              type="text"
                              value={evidenceRef}
                              onChange={(e) => setEvidenceRef(e.target.value)}
                              placeholder="e.g. CITYBANK-NPSB-STMT-2026-11-17"
                              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">
                              Finance Reviewer Notes
                            </label>
                            <textarea
                              rows={2}
                              value={verifyNotes}
                              onChange={(e) => setVerifyNotes(e.target.value)}
                              placeholder="Verified against official merchant/bank portal ledger..."
                              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                            />
                          </div>

                          {verifyError && (
                            <div className="p-2.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
                              {verifyError}
                            </div>
                          )}

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              disabled={verifyBusy}
                              onClick={() => handleManualVerify('VERIFIED')}
                              className="py-2 px-3 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
                            >
                              Approve & Settle (SUCCESS)
                            </button>
                            <button
                              type="button"
                              disabled={verifyBusy}
                              onClick={() => handleManualVerify('REJECTED')}
                              className="py-2 px-3 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors disabled:opacity-50"
                            >
                              Mark FAILED
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Payment Intent Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Create Payment Session</h3>
              <button type="button" onClick={() => setShowCreate(false)} className="text-slate-500 hover:text-slate-900">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreatePayment} className="space-y-3">
              {user.role !== 'MERCHANT_ADMIN' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={newMerchantId}
                    onChange={(e) => setNewMerchantId(e.target.value)}
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
                  <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method</label>
                  <select
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value as ProviderCode)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {ALL_PROVIDERS.map((p) => (
                      <option key={p.code} value={p.code}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Account Mode</label>
                  <select
                    value={newAccountMode}
                    onChange={(e) => setNewAccountMode(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    <option value="MERCHANT">Merchant</option>
                    <option value="PERSONAL">Personal</option>
                    <option value="AGENT">Agent</option>
                    <option value="BANK_ACCOUNT">Bank Account</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Amount (BDT)</label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="0.01"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant Order ID</label>
                  <input
                    type="text"
                    value={newOrderId}
                    onChange={(e) => setNewOrderId(e.target.value)}
                    placeholder="Auto if blank"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Customer Name</label>
                  <input
                    type="text"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Customer Phone</label>
                  <input
                    type="text"
                    value={newCustomerPhone}
                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                    placeholder="017XXXXXXXX"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              {createError && (
                <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{createError}</p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  Create Session
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
