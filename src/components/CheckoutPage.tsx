import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  FlaskConical,
  Loader2,
  QrCode,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { apiFetch, formatBdt } from '../lib/api.ts';
import { createGatewaySocket } from '../lib/socket.ts';
import { ALL_PROVIDERS, type ProviderCode } from '../types/gateway.ts';
import { PaymentStatusLabel, ProviderLabel } from './StatusText.tsx';

interface CheckoutData {
  id: string;
  merchantName: string;
  websiteDomain?: string | null;
  merchantOrderId: string;
  provider: ProviderCode;
  accountMode?: string;
  mode: 'LIVE' | 'TEST';
  amountBdt: number;
  requestedAmountBdt?: number;
  uniquePaisaOffset?: number;
  currency: string;
  referenceCode: string;
  successUrl?: string | null;
  cancelUrl?: string | null;
  verificationMethod?: string | null;
  autoVerified?: boolean;
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
    bank_name?: string | null;
  } | null;
  availableWallets: Array<{
    id: string;
    provider: ProviderCode;
    account_number: string;
    account_type: string;
    account_title: string;
    bank_name?: string | null;
  }>;
  qrDataUrl: string;
  banglaQrString?: string;
  banglaQrDataUrl?: string;
}

export function CheckoutPage({ paymentId }: { paymentId: string }) {
  const [checkout, setCheckout] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedProvider, setSelectedProvider] = useState<ProviderCode>('BKASH');
  const [senderPhone, setSenderPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [copiedAmount, setCopiedAmount] = useState(false);
  const [copiedQr, setCopiedQr] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);

  const loadCheckout = useCallback(async () => {
    try {
      const res = await apiFetch<{ checkout: CheckoutData }>(
        `/api/checkout/${paymentId}`,
        {},
        false,
      );
      setCheckout(res.checkout);
      setSelectedProvider((prev) => prev || res.checkout.provider);
      setSenderPhone((prev) => prev || res.checkout.submittedSenderPhone || '');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout session unavailable');
    } finally {
      setLoading(false);
    }
  }, [paymentId]);

  useEffect(() => {
    apiFetch<{ checkout: CheckoutData }>(`/api/checkout/${paymentId}`, {}, false)
      .then((res) => {
        setCheckout(res.checkout);
        setSelectedProvider(res.checkout.provider);
        if (res.checkout.submittedSenderPhone) setSenderPhone(res.checkout.submittedSenderPhone);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Checkout session unavailable');
        setLoading(false);
      });

    const socket = createGatewaySocket({ checkoutId: paymentId });
    socket.on('checkout:status', () => {
      loadCheckout();
    });

    const timer = setInterval(loadCheckout, 4000);
    return () => {
      clearInterval(timer);
      socket.disconnect();
    };
  }, [paymentId, loadCheckout]);

  // Automatic redirect countdown when settled and merchant provided successUrl
  useEffect(() => {
    if (checkout?.status === 'SUCCESS' && checkout.successUrl) {
      setRedirectCountdown((prev) => (prev === null ? 3 : prev));
    }
  }, [checkout?.status, checkout?.successUrl]);

  useEffect(() => {
    if (redirectCountdown === null || !checkout?.successUrl) return;
    if (redirectCountdown <= 0) {
      window.location.href = checkout.successUrl;
      return;
    }
    const t = setTimeout(() => setRedirectCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [redirectCountdown, checkout?.successUrl]);

  async function handleConfirmSent(testSimulateSuccess = false) {
    setSubmitting(true);
    setStatusMessage(null);
    setError(null);
    try {
      const res = await apiFetch<{
        status: string;
        message: string;
        successUrl?: string | null;
      }>(
        `/api/checkout/${paymentId}/confirm-sent`,
        {
          method: 'POST',
          body: JSON.stringify({
            provider: selectedProvider,
            senderPhone: senderPhone.trim() || undefined,
            testSimulateSuccess,
          }),
        },
        false,
      );
      setStatusMessage(res.message);
      await loadCheckout();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm payment');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelPayment() {
    setCancelling(true);
    setError(null);
    try {
      const res = await apiFetch<{ cancelUrl?: string | null }>(
        `/api/checkout/${paymentId}/cancel`,
        { method: 'POST' },
        false,
      );
      await loadCheckout();
      if (res.cancelUrl) {
        window.location.href = res.cancelUrl;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel session');
    } finally {
      setCancelling(false);
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
            <span>Back to Gateway</span>
          </a>
        </div>
      </div>
    );
  }

  const activeWallet =
    checkout.availableWallets.find((w) => w.provider === selectedProvider) ||
    checkout.receiverWallet;

  const isSettled = checkout.status === 'SUCCESS';
  const isFailedOrExpired = checkout.status === 'FAILED' || checkout.status === 'EXPIRED';
  const isListening = checkout.status === 'DETECTED' || checkout.status === 'MATCHED' || checkout.status === 'REVIEW_REQUIRED';
  const hasMicroOffset = Number(checkout.uniquePaisaOffset ?? 0) > 0;

  const displayedMethods =
    checkout.availableWallets.length > 0
      ? ALL_PROVIDERS.filter(
          (p) =>
            p.code === checkout.provider ||
            checkout.availableWallets.some((w) => w.provider === p.code),
        )
      : ALL_PROVIDERS;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-sm">
            <ShieldCheck className="h-4 w-4 text-teal-700" />
            <span>TakaLedger Checkout</span>
            {checkout.mode === 'TEST' && (
              <span className="inline-flex items-center gap-1 text-xs font-mono font-medium text-amber-800 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded">
                <FlaskConical className="h-3 w-3" />
                <span>TEST SANDBOX</span>
              </span>
            )}
          </div>
          {checkout.cancelUrl ? (
            <a
              href={checkout.cancelUrl}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Return to {checkout.websiteDomain || checkout.merchantName}</span>
            </a>
          ) : (
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Gateway Console</span>
            </a>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-12">
          {/* Left Column */}
          <div className="md:col-span-5 bg-slate-900 text-slate-100 p-6 flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-slate-400">Pay to Merchant</p>
                <h1 className="text-lg font-semibold text-white mt-0.5">{checkout.merchantName}</h1>
                <p className="text-xs font-mono text-slate-400 mt-1">
                  Order {checkout.merchantOrderId} · Ref {checkout.referenceCode}
                </p>
              </div>

              <div className="pt-4 border-t border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-400">Exact Payable Amount</p>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(Number(checkout.amountBdt).toFixed(2));
                      setCopiedAmount(true);
                      setTimeout(() => setCopiedAmount(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-teal-300 hover:text-teal-200"
                  >
                    <Copy className="h-3 w-3" />
                    <span>{copiedAmount ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <p className="text-3xl font-semibold font-mono tabular-nums text-white">
                  {formatBdt(checkout.amountBdt)}
                </p>
                {hasMicroOffset && (
                  <p className="text-xs text-emerald-300 leading-relaxed">
                    Includes unique +৳{Number(checkout.uniquePaisaOffset).toFixed(2)} matching code so your payment verifies automatically without entering a TrxID.
                  </p>
                )}
              </div>

              <div className="pt-4 border-t border-slate-800 space-y-2 text-xs text-slate-300">
                <p className="font-medium text-white">Zero-TrxID Automatic Steps</p>
                <p>1. Open your bKash, Nagad, Rocket, Upay, CellFin, or Bank app.</p>
                <p>
                  2. Send the <strong className="text-white">exact amount</strong> shown above to the wallet number or scan Bangla QR.
                </p>
                <p>
                  3. Click <strong className="text-white">I Have Sent the Money</strong> — no Transaction ID or screenshot upload needed.
                </p>
              </div>
            </div>

            {(checkout.banglaQrDataUrl || checkout.qrDataUrl) && (
              <div className="pt-4 border-t border-slate-800 flex items-center gap-3">
                <img
                  src={
                    selectedProvider === 'BANGLA_QR' && checkout.banglaQrDataUrl
                      ? checkout.banglaQrDataUrl
                      : checkout.qrDataUrl
                  }
                  alt="Payment QR"
                  className="w-20 h-20 bg-white p-1 rounded shrink-0"
                />
                <div className="text-xs text-slate-300">
                  <p className="font-medium text-white">
                    {selectedProvider === 'BANGLA_QR' ? 'EMVCo Bangla QR' : 'Payment QR'}
                  </p>
                  <p className="text-slate-400 mt-0.5">
                    {selectedProvider === 'BANGLA_QR'
                      ? 'Scan with Citytouch, bKash, Nagad, Rocket, or CellFin'
                      : 'Encodes wallet, exact BDT amount, and reference'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Right Column */}
          <div className="md:col-span-7 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <PaymentStatusLabel status={checkout.status} />
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 font-mono">
                <Clock className="h-3.5 w-3.5" />
                <span>{checkout.mode === 'TEST' ? 'Sandbox Session' : 'Live Auto-Verify'}</span>
              </span>
            </div>

            {isSettled ? (
              <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-xl space-y-3">
                <div className="flex items-center gap-2 text-emerald-900 font-semibold text-sm">
                  <CheckCircle2 className="h-5 w-5" />
                  <span>Payment Automatically Verified & Settled</span>
                </div>
                <p className="text-xs text-emerald-800 leading-relaxed">
                  {formatBdt(checkout.amountBdt)} for order{' '}
                  <span className="font-mono font-semibold">{checkout.merchantOrderId}</span> has been confirmed
                  {checkout.submittedTrxId ? (
                    <>
                      {' '}
                      (Ref <span className="font-mono font-semibold">{checkout.submittedTrxId}</span>)
                    </>
                  ) : null}
                  .
                </p>
                {checkout.successUrl && (
                  <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-emerald-200">
                    <span className="text-xs text-emerald-800 font-mono">
                      Redirecting to merchant in {redirectCountdown ?? 3}s...
                    </span>
                    <a
                      href={checkout.successUrl}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg"
                    >
                      <span>Return to Merchant</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                  </div>
                )}
              </div>
            ) : isFailedOrExpired ? (
              <div className="p-5 bg-rose-50 border border-rose-200 rounded-xl space-y-3">
                <div className="flex items-center gap-2 text-rose-900 font-semibold text-sm">
                  <XCircle className="h-5 w-5" />
                  <span>Session {checkout.status}</span>
                </div>
                <p className="text-xs text-rose-800">
                  This payment session is closed. Please start a new checkout from the merchant website.
                </p>
                {checkout.cancelUrl && (
                  <a
                    href={checkout.cancelUrl}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-rose-800 bg-white border border-rose-300 rounded-lg"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>Return to Store</span>
                  </a>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-2">
                    Select Payment Method
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {displayedMethods.map((p) => (
                      <button
                        key={p.code}
                        type="button"
                        onClick={() => setSelectedProvider(p.code)}
                        className={`p-2.5 rounded-lg border text-left transition-colors ${
                          selectedProvider === p.code
                            ? 'border-teal-700 bg-teal-50/60'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <ProviderLabel provider={p.code} />
                      </button>
                    ))}
                  </div>
                </div>

                {selectedProvider === 'BANGLA_QR' && checkout.banglaQrDataUrl && (
                  <div className="p-4 bg-teal-50/50 border border-teal-200 rounded-xl flex flex-col sm:flex-row items-center gap-4">
                    <img
                      src={checkout.banglaQrDataUrl}
                      alt="Bangla QR Code"
                      className="w-32 h-32 bg-white p-1.5 border border-teal-200 rounded-lg shrink-0"
                    />
                    <div className="space-y-2 text-xs min-w-0">
                      <div className="flex items-center gap-1.5 font-semibold text-teal-900">
                        <QrCode className="h-4 w-4" />
                        <span>Scan Bangla QR (NPSB Interoperable)</span>
                      </div>
                      <p className="text-slate-700 leading-relaxed">
                        Supports Citytouch, DBBL NexusPay/Rocket, Islami Bank CellFin, bKash, and Nagad.
                      </p>
                      {checkout.banglaQrString && (
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(checkout.banglaQrString!);
                            setCopiedQr(true);
                            setTimeout(() => setCopiedQr(false), 1500);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 bg-white border border-teal-300 rounded-md"
                        >
                          <Copy className="h-3 w-3" />
                          <span>{copiedQr ? 'Copied' : 'Copy EMVCo Payload'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {activeWallet && (
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-slate-500">
                        Send Exact {formatBdt(checkout.amountBdt)} to {selectedProvider} ({activeWallet.account_type})
                      </p>
                      <p className="text-lg font-mono font-semibold text-slate-900 mt-0.5">
                        {activeWallet.account_number}
                      </p>
                      <p className="text-xs text-slate-600">
                        {activeWallet.account_title}
                        {activeWallet.bank_name ? ` · ${activeWallet.bank_name}` : ''}
                      </p>
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

                {isListening && (
                  <div className="p-3.5 bg-teal-50 border border-teal-200 rounded-lg flex items-start gap-2.5 text-xs text-teal-900">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">
                        Listening for incoming {selectedProvider} SMS / App Notification...
                      </p>
                      <p className="text-teal-800 mt-0.5">
                        {statusMessage ||
                          'Once the merchant phone detects your transfer, this page will verify and redirect automatically.'}
                      </p>
                    </div>
                  </div>
                )}

                <div className="space-y-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Your Sender Mobile Number <span className="text-slate-400 font-normal">(Optional — speeds up matching)</span>
                    </label>
                    <input
                      type="tel"
                      value={senderPhone}
                      onChange={(e) => setSenderPhone(e.target.value)}
                      placeholder="017XXXXXXXX"
                      className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-teal-700"
                    />
                  </div>

                  {error && (
                    <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
                      {error}
                    </div>
                  )}

                  {statusMessage && !isListening && (
                    <div className="p-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
                      {statusMessage}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <button
                      type="button"
                      disabled={submitting || cancelling}
                      onClick={() => handleConfirmSent(false)}
                      className="flex-1 py-2.5 px-4 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {submitting
                        ? 'Checking Incoming SMS...'
                        : isListening
                          ? 'Re-check Automatic Match'
                          : 'I Have Sent the Money'}
                    </button>

                    <button
                      type="button"
                      disabled={submitting || cancelling}
                      onClick={handleCancelPayment}
                      className="py-2.5 px-4 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {cancelling ? 'Cancelling...' : 'Cancel Payment'}
                    </button>
                  </div>

                  {checkout.mode === 'TEST' && (
                    <button
                      type="button"
                      disabled={submitting || cancelling}
                      onClick={() => handleConfirmSent(true)}
                      className="w-full py-2 px-4 text-xs font-medium text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5"
                    >
                      <FlaskConical className="h-3.5 w-3.5" />
                      <span>Simulate Test Mode Payment Success (Sandbox)</span>
                    </button>
                  )}
                </div>

                <p className="text-xs text-slate-500">
                  No Transaction ID or screenshot upload required. Verified automatically via encrypted Android Agent SMS & notification matching.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
