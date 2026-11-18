import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock, Copy, ShieldCheck } from 'lucide-react';
import { apiFetch, formatBdt } from '../lib/api.ts';
import type { ProviderCode } from '../types/gateway.ts';
import { PaymentStatusLabel, ProviderLabel } from './StatusText.tsx';

interface CheckoutData {
  id: string;
  merchantName: string;
  merchantOrderId: string;
  provider: ProviderCode;
  amountBdt: number;
  currency: string;
  referenceCode: string;
  submittedTrxId: string | null;
  submittedSenderPhone: string | null;
  status: string;
  expiresAt: string;
  receiverWallet: {
    id: string;
    provider: ProviderCode;
    account_number: string;
    account_type: string;
    account_title: string;
  } | null;
  availableWallets: Array<{
    id: string;
    provider: ProviderCode;
    account_number: string;
    account_type: string;
    account_title: string;
  }>;
  qrDataUrl: string;
}

export function CheckoutPage({ paymentId }: { paymentId: string }) {
  const [checkout, setCheckout] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProvider, setSelectedProvider] = useState<ProviderCode>('BKASH');
  const [senderPhone, setSenderPhone] = useState('');
  const [trxId, setTrxId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [copiedWallet, setCopiedWallet] = useState(false);

  const loadCheckout = useCallback(async () => {
    try {
      const res = await apiFetch<{ checkout: CheckoutData }>(
        `/api/checkout/${paymentId}`,
        {},
        false,
      );
      setCheckout(res.checkout);
      setSelectedProvider(res.checkout.provider);
      if (res.checkout.submittedSenderPhone && !senderPhone) {
        setSenderPhone(res.checkout.submittedSenderPhone);
      }
      if (res.checkout.submittedTrxId && !trxId) {
        setTrxId(res.checkout.submittedTrxId);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout session unavailable');
    } finally {
      setLoading(false);
    }
  }, [paymentId, senderPhone, trxId]);

  useEffect(() => {
    loadCheckout();
    const timer = setInterval(loadCheckout, 10_000);
    return () => clearInterval(timer);
  }, [loadCheckout]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMsg(null);
    setError(null);
    try {
      const res = await apiFetch<{ status: string; message: string }>(
        `/api/checkout/${paymentId}/submit`,
        {
          method: 'POST',
          body: JSON.stringify({
            provider: selectedProvider,
            senderPhone,
            trxId,
          }),
        },
        false,
      );
      setSubmitMsg(res.message);
      await loadCheckout();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="w-full max-w-lg h-96 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!checkout) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full text-center space-y-3">
          <h1 className="text-lg font-semibold text-slate-900">Checkout Session Not Found</h1>
          <p className="text-xs text-slate-600">{error || 'Invalid or expired payment link.'}</p>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Gateway Console</span>
          </a>
        </div>
      </div>
    );
  }

  const activeWallet =
    checkout.availableWallets.find((w) => w.provider === selectedProvider) ||
    checkout.receiverWallet;

  const isSettled = checkout.status === 'VERIFIED_SETTLED';

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-sm">
            <ShieldCheck className="h-4 w-4 text-teal-700" />
            <span>TakaLedger Checkout</span>
          </div>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Admin Console</span>
          </a>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-12">
          {/* Left Column: Merchant Order Summary & Receiver Instructions */}
          <div className="md:col-span-5 bg-slate-900 text-slate-100 p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-slate-400">Pay to Merchant</p>
                <h1 className="text-lg font-semibold text-white mt-0.5">{checkout.merchantName}</h1>
                <p className="text-xs font-mono text-slate-400 mt-1">
                  Order {checkout.merchantOrderId} · Ref {checkout.referenceCode}
                </p>
              </div>

              <div className="pt-4 border-t border-slate-800">
                <p className="text-xs text-slate-400">Total Payable</p>
                <p className="text-3xl font-semibold font-mono tabular-nums text-white mt-1">
                  {formatBdt(checkout.amountBdt)}
                </p>
              </div>

              <div className="pt-4 border-t border-slate-800 space-y-2 text-xs text-slate-300">
                <p className="font-medium text-white">Payment Steps</p>
                <p>1. Select your MFS wallet provider on the right.</p>
                <p>2. Open bKash, Nagad, or Rocket app and send exact amount to the wallet number below.</p>
                <p>3. Enter reference <span className="font-mono text-white">{checkout.referenceCode}</span> if prompted, then submit your TrxID.</p>
              </div>
            </div>

            {checkout.qrDataUrl && (
              <div className="pt-4 border-t border-slate-800 flex items-center gap-3">
                <img
                  src={checkout.qrDataUrl}
                  alt="MFS Payment QR"
                  className="w-16 h-16 bg-white p-1 rounded"
                />
                <div className="text-xs text-slate-300">
                  <p className="font-medium text-white">Scan Reference QR</p>
                  <p className="text-slate-400">Contains wallet, amount, and order reference</p>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Wallet Selection & TrxID Submission */}
          <div className="md:col-span-7 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <PaymentStatusLabel status={checkout.status} />
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 font-mono">
                <Clock className="h-3.5 w-3.5" />
                <span>BDT Checkout</span>
              </span>
            </div>

            {isSettled ? (
              <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-emerald-900 font-semibold text-sm">
                  <CheckCircle2 className="h-5 w-5" />
                  <span>Payment Verified & Settled</span>
                </div>
                <p className="text-xs text-emerald-800">
                  Transaction <span className="font-mono font-semibold">{checkout.submittedTrxId}</span> for{' '}
                  <span className="font-mono font-semibold">{formatBdt(checkout.amountBdt)}</span> has been verified and confirmed to {checkout.merchantName}.
                </p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-2">
                    Select MFS Method
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['BKASH', 'NAGAD', 'ROCKET'] as ProviderCode[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setSelectedProvider(p)}
                        className={`p-2.5 rounded-lg border text-left transition-colors ${
                          selectedProvider === p
                            ? 'border-teal-700 bg-teal-50/60'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <ProviderLabel provider={p} />
                      </button>
                    ))}
                  </div>
                </div>

                {activeWallet && (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-slate-500">
                        Send {selectedProvider} ({activeWallet.account_type}) To
                      </p>
                      <p className="text-lg font-mono font-semibold text-slate-900 mt-0.5">
                        {activeWallet.account_number}
                      </p>
                      <p className="text-xs text-slate-600">{activeWallet.account_title}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(activeWallet.account_number);
                        setCopiedWallet(true);
                        setTimeout(() => setCopiedWallet(false), 1500);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{copiedWallet ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Your Sender Mobile Number
                    </label>
                    <input
                      type="tel"
                      required
                      value={senderPhone}
                      onChange={(e) => setSenderPhone(e.target.value)}
                      placeholder="017XXXXXXXX"
                      className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Transaction ID (TrxID)
                    </label>
                    <input
                      type="text"
                      required
                      value={trxId}
                      onChange={(e) => setTrxId(e.target.value.toUpperCase())}
                      placeholder="e.g. BKH7721K9P"
                      className="w-full px-3.5 py-2.5 text-sm font-mono uppercase border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  {error && (
                    <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
                      {error}
                    </div>
                  )}

                  {submitMsg && (
                    <div className="p-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
                      {submitMsg}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 px-4 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {submitting ? 'Submitting Transaction...' : 'Submit Transaction ID'}
                  </button>
                </form>

                <p className="text-xs text-slate-500">
                  Final settlement completes only after official provider API confirmation or finance verification.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
