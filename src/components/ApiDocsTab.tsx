import { useState } from 'react';
import { Check, Code2, Copy, Send, Webhook } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { AuthUser, MerchantRow } from '../types/gateway.ts';

interface ApiDocsTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
}

type LangTab = 'NODE' | 'NEXTJS' | 'PHP' | 'LARAVEL' | 'WOOCOMMERCE';

export function ApiDocsTab({ user, merchants }: ApiDocsTabProps) {
  const [lang, setLang] = useState<LangTab>('NODE');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [testWebhookStatus, setTestWebhookStatus] = useState<string | null>(null);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://pay.yourdomain.bd';
  const activeMerchant = merchants.find((m) => m.id === user.merchantId) ?? merchants[0];
  const sampleKey = activeMerchant?.api_key_prefix
    ? `${activeMerchant.api_key_prefix}••••••••••••••••`
    : 'tl_live_your_merchant_key';
  const sampleTestKey = activeMerchant?.test_api_key_prefix
    ? `${activeMerchant.test_api_key_prefix}••••••••••••••••`
    : 'tl_test_your_sandbox_key';

  function copySnippet(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function handleSendTestWebhook() {
    if (!activeMerchant) return;
    setTestingWebhook(true);
    setTestWebhookStatus(null);
    try {
      const res = await apiFetch<{ delivered: boolean; httpStatus: number | null; targetUrl: string }>(
        `/api/merchants/${activeMerchant.id}/test-webhook`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setTestWebhookStatus(
        res.delivered
          ? `Delivered test webhook (HTTP ${res.httpStatus}) to ${res.targetUrl}`
          : `Dispatched to ${res.targetUrl} — returned HTTP ${res.httpStatus ?? 'Network Error'}`,
      );
    } catch (err) {
      setTestWebhookStatus(err instanceof Error ? err.message : 'Test webhook failed');
    } finally {
      setTestingWebhook(false);
    }
  }

  const snippets: Record<LangTab, { title: string; code: string }> = {
    NODE: {
      title: 'Node.js (Express / Fetch) — Zero-TrxID Payment Session',
      code: `const response = await fetch('${origin}/api/v1/payments', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${sampleKey}',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-' + orderId,
  },
  body: JSON.stringify({
    merchantOrderId: orderId,
    provider: 'BKASH',          // BKASH | NAGAD | ROCKET | UPAY | CELLFIN | BANGLA_QR | BANK_SMS
    accountMode: 'PERSONAL',    // PERSONAL | MERCHANT
    amountBdt: 1250,
    uniqueMicroAmount: true,    // Optional: appends .01-.99 paisa for collision-free Zero-TrxID matching
    customerName: 'Customer Name',
    customerPhone: '017XXXXXXXX',
    successUrl: 'https://yourstore.bd/payment/success?order=' + orderId,
    cancelUrl: 'https://yourstore.bd/payment/cancel?order=' + orderId,
    callbackUrl: 'https://yourstore.bd/api/takaledger-webhook',
  }),
});

const data = await response.json();
// Redirect shopper directly to TakaLedger Zero-TrxID Checkout:
// res.redirect(data.checkoutUrl);`,
    },
    NEXTJS: {
      title: 'Next.js App Router (Route Handler + Redirect)',
      code: `// app/api/checkout/route.ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const { orderId, amountBdt, phone } = await req.json();
  const res = await fetch('${origin}/api/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.TAKALEDGER_API_KEY}\`,
      'X-Api-Secret': process.env.TAKALEDGER_API_SECRET!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      merchantOrderId: orderId,
      provider: 'NAGAD',
      amountBdt,
      customerPhone: phone,
      successUrl: \`\${process.env.NEXT_PUBLIC_SITE_URL}/orders/\${orderId}/paid\`,
      cancelUrl: \`\${process.env.NEXT_PUBLIC_SITE_URL}/checkout?cancelled=1\`,
    }),
  });
  const session = await res.json();
  return NextResponse.json({ checkoutUrl: session.checkoutUrl, paymentId: session.paymentId });
}`,
    },
    PHP: {
      title: 'PHP (cURL) — Create Zero-TrxID Payment & Redirect',
      code: `<?php
$payload = json_encode([
    'merchantOrderId' => 'INV-' . time(),
    'provider'        => 'BKASH',
    'accountMode'     => 'PERSONAL',
    'amountBdt'       => 850,
    'customerPhone'   => '01711223344',
    'successUrl'      => 'https://daktarserial.online/payment-success',
    'cancelUrl'       => 'https://daktarserial.online/payment-cancel',
    'callbackUrl'     => 'https://daktarserial.online/takaledger-webhook.php',
]);

$ch = curl_init('${origin}/api/v1/payments');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Authorization: Bearer ${sampleKey}',
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS     => $payload,
]);

$result = json_decode(curl_exec($ch), true);
curl_close($ch);

header('Location: ' . $result['checkoutUrl']);
exit;`,
    },
    LARAVEL: {
      title: 'Laravel Http Client + Signed Webhook Controller',
      code: `// PaymentController.php
$response = Http::withToken(config('services.takaledger.api_key'))
    ->withHeaders(['Idempotency-Key' => 'ord-' . $order->id])
    ->post('${origin}/api/v1/payments', [
        'merchantOrderId' => $order->invoice_no,
        'provider'        => 'BKASH',
        'amountBdt'       => $order->total_bdt,
        'customerPhone'   => $order->customer_phone,
        'successUrl'      => route('payment.success', $order),
        'cancelUrl'       => route('payment.cancel', $order),
        'callbackUrl'     => route('webhooks.takaledger'),
    ])->throw()->json();

return redirect()->away($response['checkoutUrl']);`,
    },
    WOOCOMMERCE: {
      title: 'WordPress / WooCommerce Official Plugin Setup',
      code: `1. Zip or upload /woocommerce-plugin/takaledger-gateway/ into wp-content/plugins/
2. Activate "TakaLedger Payment Gateway (Bangladesh)" in WordPress Admin.
3. WooCommerce -> Settings -> Payments -> TakaLedger Gateway:
   - Gateway Base URL : ${origin}
   - Merchant API Key : ${sampleKey}  (or ${sampleTestKey} for sandbox)
   - Webhook Secret   : Paste your Webhook HMAC Secret from Merchants & Websites tab
   - Webhook Endpoint : https://yourstore.bd/wp-json/takaledger/v1/webhook
4. Customers pay via Zero-TrxID Checkout and auto-return to WooCommerce Order Received.`,
    },
  };

  const webhookVerifySnippet = `// Verify X-Gateway-Signature: t=<unix>,v1=<hmac_sha256>
import crypto from 'node:crypto';

export function verifyTakaLedgerWebhook(rawBody: string, header: string, webhookSecret: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(\`\${parts.t}.\${rawBody}\`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));
}`;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Code2 className="h-5 w-5 text-teal-700 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Merchant API v1 Integration Guide (Zero-TrxID & Live/Test Modes)
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Use <span className="font-mono">tl_live_*</span> for real settlements or <span className="font-mono">tl_test_*</span> for sandbox testing. Supports both <span className="font-mono">Authorization: Bearer</span> and <span className="font-mono">X-Merchant-Key</span>.
            </p>
          </div>
        </div>

        {activeMerchant && (
          <button
            type="button"
            disabled={testingWebhook}
            onClick={handleSendTestWebhook}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg whitespace-nowrap shrink-0"
          >
            <Send className="h-3.5 w-3.5" />
            <span>{testingWebhook ? 'Sending...' : 'Send Test Webhook'}</span>
          </button>
        )}
      </div>

      {testWebhookStatus && (
        <div className="p-3.5 text-xs bg-slate-900 text-emerald-300 font-mono rounded-xl">
          {testWebhookStatus}
        </div>
      )}

      {/* Endpoints Quick Reference */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <p className="text-xs font-mono font-semibold text-teal-700">GET /api/v1/methods</p>
          <p className="text-xs text-slate-600">Returns active payment channels & wallets scoped to your subscription plan.</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <p className="text-xs font-mono font-semibold text-teal-700">POST /api/v1/payments</p>
          <p className="text-xs text-slate-600">Creates a Zero-TrxID checkout session and returns `checkoutUrl`, `qrDataUrl`, & `banglaQrString`.</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
          <p className="text-xs font-mono font-semibold text-teal-700">GET /api/v1/payments/:id</p>
          <p className="text-xs text-slate-600">Polls authoritative status (`PENDING`, `DETECTED`, `MATCHED`, `SUCCESS`, `FAILED`).</p>
        </div>
      </div>

      {/* Multi-Language Integration Snippets */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'NODE', label: 'Node.js' },
                { id: 'NEXTJS', label: 'Next.js' },
                { id: 'PHP', label: 'PHP' },
                { id: 'LARAVEL', label: 'Laravel' },
                { id: 'WOOCOMMERCE', label: 'WordPress / WooCommerce' },
              ] as Array<{ id: LangTab; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setLang(t.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                  lang === t.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => copySnippet('main', snippets[lang].code)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            {copiedId === 'main' ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copiedId === 'main' ? 'Copied' : 'Copy Code'}</span>
          </button>
        </div>

        <div className="bg-slate-950 p-5 space-y-2">
          <p className="text-xs font-medium text-slate-400">{snippets[lang].title}</p>
          <pre className="text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
            {snippets[lang].code}
          </pre>
        </div>
      </div>

      {/* Webhook HMAC Verification */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4 text-teal-700" />
            <h3 className="text-xs font-semibold text-slate-900">
              Webhook Signature Verification (`X-Gateway-Signature`)
            </h3>
          </div>
          <button
            type="button"
            onClick={() => copySnippet('webhook', webhookVerifySnippet)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
          >
            {copiedId === 'webhook' ? <Check className="h-3 w-3 text-emerald-700" /> : <Copy className="h-3 w-3" />}
            <span>{copiedId === 'webhook' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="bg-slate-950 p-5 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
          {webhookVerifySnippet}
        </pre>
      </div>
    </div>
  );
}
