import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Lock,
  ShieldCheck,
  Sparkles,
  Store,
} from 'lucide-react';
import { apiFetch, formatBdt, setStoredToken } from '../lib/api.ts';
import type { AuthUser, SubscriptionPackage, UserRole } from '../types/gateway.ts';

interface LoginViewProps {
  onLoginSuccess: (user: AuthUser) => void;
}

interface RegisteredCredentials {
  token: string;
  user: AuthUser;
  merchantName: string;
  packageName: string;
  trialEndsAt: string;
  verificationToken?: string | null;
  liveApiKey: string;
  testApiKey: string;
  apiSecret: string;
  webhookSecret: string;
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [viewMode, setViewMode] = useState<'SIGN_IN' | 'PRICING' | 'REGISTER'>('SIGN_IN');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devQuickEnabled, setDevQuickEnabled] = useState(false);

  const [packages, setPackages] = useState<SubscriptionPackage[]>([]);
  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [selectedPackageCode, setSelectedPackageCode] = useState('STARTER');

  const [regBusinessName, setRegBusinessName] = useState('');
  const [regFullName, setRegFullName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regWebsite, setRegWebsite] = useState('');
  const [regPlatform, setRegPlatform] = useState<'WOOCOMMERCE' | 'LARAVEL' | 'CUSTOM' | 'SHOPIFY'>('CUSTOM');
  const [regPassword, setRegPassword] = useState('');
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [registeredCreds, setRegisteredCreds] = useState<RegisteredCredentials | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ devQuickLoginEnabled: boolean }>('/api/auth/dev-mode', {}, false)
      .then((res) => setDevQuickEnabled(res.devQuickLoginEnabled))
      .catch(() => setDevQuickEnabled(false));

    apiFetch<{ packages: SubscriptionPackage[] }>('/api/packages', {}, false)
      .then((res) => setPackages(res.packages))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        },
        false,
      );
      setStoredToken(res.token);
      onLoginSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDevRoleSignIn(role: UserRole) {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>(
        '/api/auth/dev-quick-login',
        {
          method: 'POST',
          body: JSON.stringify({ role }),
        },
        false,
      );
      setStoredToken(res.token);
      onLoginSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quick sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterMerchant(e: React.FormEvent) {
    e.preventDefault();
    setRegBusy(true);
    setRegError(null);
    try {
      const res = await apiFetch<{
        token: string;
        user: AuthUser;
        merchant: {
          name: string;
          packageName: string;
          trialEndsAt: string;
        };
        website: { verificationToken?: string } | null;
        credentialsOnce: {
          liveApiKey: string;
          testApiKey: string;
          apiSecret: string;
          webhookSecret: string;
        };
      }>(
        '/api/auth/register-merchant',
        {
          method: 'POST',
          body: JSON.stringify({
            businessName: regBusinessName,
            fullName: regFullName || regBusinessName,
            email: regEmail,
            password: regPassword,
            businessPhone: regPhone || undefined,
            websiteDomain: regWebsite || undefined,
            websiteName: regBusinessName,
            platform: regPlatform,
            packageCode: selectedPackageCode,
            billingCycle,
          }),
        },
        false,
      );
      setStoredToken(res.token);
      setRegisteredCreds({
        token: res.token,
        user: res.user,
        merchantName: res.merchant.name,
        packageName: res.merchant.packageName,
        trialEndsAt: res.merchant.trialEndsAt,
        verificationToken: res.website?.verificationToken,
        liveApiKey: res.credentialsOnce.liveApiKey,
        testApiKey: res.credentialsOnce.testApiKey,
        apiSecret: res.credentialsOnce.apiSecret,
        webhookSecret: res.credentialsOnce.webhookSecret,
      });
    } catch (err) {
      setRegError(err instanceof Error ? err.message : 'Merchant registration failed');
    } finally {
      setRegBusy(false);
    }
  }

  function copyValue(label: string, val: string) {
    navigator.clipboard.writeText(val);
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  if (registeredCreds) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-medium text-emerald-700">
                <ShieldCheck className="h-4 w-4" />
                <span>Merchant Account Provisioned · 14-Day {registeredCreds.packageName} Trial</span>
              </div>
              <h2 className="text-xl font-semibold text-slate-900 mt-1">
                Welcome, {registeredCreds.merchantName}
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Save your Live, Test, and Webhook HMAC secrets now — they are encrypted at rest and never displayed again.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {[
              { id: 'live', label: 'Live Merchant API Key', val: registeredCreds.liveApiKey },
              { id: 'test', label: 'Test Sandbox API Key', val: registeredCreds.testApiKey },
              { id: 'secret', label: 'API Secret Header (X-Api-Secret)', val: registeredCreds.apiSecret },
              { id: 'webhook', label: 'Webhook HMAC Secret (X-Gateway-Signature)', val: registeredCreds.webhookSecret },
            ].map((item) => (
              <div key={item.id} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-xs font-medium text-slate-600 mb-1">{item.label}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-slate-900 break-all">{item.val}</code>
                  <button
                    type="button"
                    onClick={() => copyValue(item.id, item.val)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 shrink-0"
                  >
                    <Copy className="h-3 w-3" />
                    <span>{copiedKey === item.id ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            ))}

            {registeredCreds.verificationToken && (
              <div className="bg-teal-50/60 border border-teal-200 rounded-lg p-3 text-xs text-teal-900">
                <span className="font-semibold">Website Verification Token:</span>{' '}
                <code className="font-mono">{registeredCreds.verificationToken}</code>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => onLoginSuccess(registeredCreds.user)}
            className="w-full py-2.5 px-4 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors"
          >
            Enter Merchant Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar */}
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-teal-700 shrink-0" />
          <span className="font-display font-semibold text-base tracking-tight text-slate-900 whitespace-nowrap">
            TakaLedger SaaS
          </span>
        </div>

        <nav className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('SIGN_IN')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              viewMode === 'SIGN_IN' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => setViewMode('PRICING')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              viewMode === 'PRICING' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Packages & Pricing
          </button>
          <button
            type="button"
            onClick={() => setViewMode('REGISTER')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              viewMode === 'REGISTER'
                ? 'bg-teal-700 text-white'
                : 'bg-teal-50 text-teal-800 border border-teal-200 hover:bg-teal-100'
            }`}
          >
            Create Merchant Account
          </button>
        </nav>
      </header>

      <div className="flex-1 flex items-center justify-center p-4 sm:p-8">
        {viewMode === 'PRICING' ? (
          <div className="w-full max-w-6xl space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-teal-700">Commercial Multi-Merchant SaaS Plans</p>
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
                  Automated Zero-TrxID Payment Gateway Subscriptions
                </h1>
                <p className="text-sm text-slate-600 mt-1">
                  Connect your own websites and Personal/Merchant bKash, Nagad, Rocket, Upay, CellFin, and Bangla QR wallets with our Android Agent APK.
                </p>
              </div>

              <div className="inline-flex bg-white border border-slate-200 rounded-lg p-1 shrink-0 self-start">
                <button
                  type="button"
                  onClick={() => setBillingCycle('MONTHLY')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                    billingCycle === 'MONTHLY' ? 'bg-slate-900 text-white' : 'text-slate-600'
                  }`}
                >
                  Monthly
                </button>
                <button
                  type="button"
                  onClick={() => setBillingCycle('YEARLY')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                    billingCycle === 'YEARLY' ? 'bg-slate-900 text-white' : 'text-slate-600'
                  }`}
                >
                  Yearly (Save 2 Months)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              {packages.map((pkg) => {
                const price = billingCycle === 'YEARLY' ? pkg.yearlyPriceBdt : pkg.monthlyPriceBdt;
                const isFeatured = pkg.code === 'PROFESSIONAL';
                return (
                  <div
                    key={pkg.id}
                    className={`bg-white rounded-xl p-5 flex flex-col justify-between border ${
                      isFeatured ? 'border-teal-700 ring-1 ring-teal-700' : 'border-slate-200'
                    }`}
                  >
                    <div className="space-y-4">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-base font-semibold text-slate-900">{pkg.name}</h2>
                          {isFeatured && (
                            <span className="text-[11px] font-mono font-semibold text-teal-700">POPULAR</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{pkg.tagline}</p>
                      </div>

                      <div className="pt-3 border-t border-slate-100">
                        <p className="text-2xl font-semibold font-mono tabular-nums text-slate-900">
                          {formatBdt(price)}
                        </p>
                        <p className="text-xs text-slate-500">
                          per {billingCycle === 'YEARLY' ? 'year' : 'month'} · 14-day free trial
                        </p>
                      </div>

                      <ul className="space-y-2 text-xs text-slate-700">
                        <li className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                          <span>{pkg.maxWebsites >= 100 ? 'Unlimited' : pkg.maxWebsites} Website(s)</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                          <span>{pkg.maxDevices >= 100 ? 'Unlimited' : pkg.maxDevices} Android Device(s)</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                          <span>{pkg.monthlyTxLimit.toLocaleString()} TX / month</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                          <span>{pkg.allowedProviders.length} Payment Channels</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                          <span>Zero-TrxID Auto Matching</span>
                        </li>
                      </ul>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPackageCode(pkg.code);
                        setViewMode('REGISTER');
                      }}
                      className={`mt-6 w-full py-2 px-3 text-xs font-medium rounded-lg transition-colors ${
                        isFeatured
                          ? 'bg-teal-700 hover:bg-teal-800 text-white'
                          : 'bg-slate-900 hover:bg-slate-800 text-white'
                      }`}
                    >
                      Start 14-Day Free Trial
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : viewMode === 'REGISTER' ? (
          <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="lg:col-span-5 bg-slate-900 text-slate-100 p-8 flex flex-col justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-400 text-xs font-medium">
                  <Store className="h-4 w-4" />
                  <span>Merchant SaaS Onboarding</span>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">
                  Launch Your Automated Payment Gateway in Minutes
                </h1>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Receive instant Live & Test API keys, connect WordPress/WooCommerce, Laravel, Next.js, or PHP storefronts, and pair your Android phones via QR code.
                </p>
              </div>

              <div className="mt-8 pt-6 border-t border-slate-800 space-y-2 text-xs text-slate-300">
                <p className="font-medium text-white">Included with Every Merchant Account</p>
                <p>1. Zero-TrxID checkout (customers never enter TrxIDs or upload screenshots).</p>
                <p>2. Live (`tl_live_`) & Test Sandbox (`tl_test_`) keys with signed webhooks.</p>
                <p>3. Dedicated Android Agent APK v2.1.0 for Personal & Merchant wallets.</p>
              </div>
            </div>

            <div className="lg:col-span-7 p-8">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Create Merchant Account</h2>
                  <p className="text-xs text-slate-500">Starts with a 14-day free trial — upgrade anytime.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setViewMode('PRICING')}
                  className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
                >
                  Compare Plans
                </button>
              </div>

              <form onSubmit={handleRegisterMerchant} className="mt-5 space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Business Name</label>
                    <input
                      type="text"
                      required
                      value={regBusinessName}
                      onChange={(e) => setRegBusinessName(e.target.value)}
                      placeholder="e.g. DaktarSerial Online"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Owner Full Name</label>
                    <input
                      type="text"
                      required
                      value={regFullName}
                      onChange={(e) => setRegFullName(e.target.value)}
                      placeholder="e.g. Tariqul Islam"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Work Email</label>
                    <input
                      type="email"
                      required
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      placeholder="owner@yourbusiness.bd"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Business Mobile</label>
                    <input
                      type="tel"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                      placeholder="017XXXXXXXX"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Website Domain (Optional)</label>
                    <input
                      type="text"
                      value={regWebsite}
                      onChange={(e) => setRegWebsite(e.target.value)}
                      placeholder="daktarserial.online"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Website Stack</label>
                    <select
                      value={regPlatform}
                      onChange={(e) =>
                        setRegPlatform(e.target.value as 'WOOCOMMERCE' | 'LARAVEL' | 'CUSTOM' | 'SHOPIFY')
                      }
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    >
                      <option value="CUSTOM">Next.js / Node.js / PHP API</option>
                      <option value="WOOCOMMERCE">WordPress / WooCommerce</option>
                      <option value="LARAVEL">Laravel</option>
                      <option value="SHOPIFY">Shopify</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Selected Plan</label>
                    <select
                      value={selectedPackageCode}
                      onChange={(e) => setSelectedPackageCode(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    >
                      {packages.length === 0 ? (
                        <option value="STARTER">Starter</option>
                      ) : (
                        packages.map((p) => (
                          <option key={p.id} value={p.code}>
                            {p.name} — {formatBdt(billingCycle === 'YEARLY' ? p.yearlyPriceBdt : p.monthlyPriceBdt)}/{billingCycle === 'YEARLY' ? 'yr' : 'mo'}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Password (Min 8 chars)</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Strong account password"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                {regError && (
                  <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
                    {regError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={regBusy}
                  className="w-full py-2.5 px-4 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  <Sparkles className="h-4 w-4" />
                  <span>{regBusy ? 'Provisioning Merchant Tenant...' : 'Create Merchant Account & Issue API Keys'}</span>
                </button>
              </form>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="lg:col-span-5 bg-slate-900 text-slate-100 p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2.5 text-emerald-400 text-sm font-medium">
                  <ShieldCheck className="h-5 w-5" />
                  <span>TakaLedger Gateway</span>
                </div>
                <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white text-balance">
                  Bangladesh Multi-Merchant Zero-TrxID Payment Platform
                </h1>
                <p className="mt-3 text-sm text-slate-300 leading-relaxed">
                  Automated bKash, Nagad, Rocket, Upay, Islami Bank CellFin, Bangla QR, and Bank SMS verification with tenant-isolated merchant portals and paired Android listeners.
                </p>
              </div>

              <div className="mt-10 pt-6 border-t border-slate-800 space-y-2.5 text-xs text-slate-300">
                <p className="font-medium text-white">Commercial Platform Capabilities</p>
                <p>1. Zero-TrxID checkout with micro-amount disambiguation and auto-settlement.</p>
                <p>2. Live & Test API modes, domain verification, and signed HMAC webhooks.</p>
                <p>3. Commercial SaaS packages with quota enforcement and OTP/PIN redaction.</p>
              </div>
            </div>

            <div className="lg:col-span-7 p-8 sm:p-10">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
                  <Lock className="h-3.5 w-3.5" />
                  <span>Authorized Operator & Merchant Sign-In</span>
                </div>
                <button
                  type="button"
                  onClick={() => setViewMode('REGISTER')}
                  className="text-xs font-medium text-teal-700 hover:underline inline-flex items-center gap-1"
                >
                  <KeyRound className="h-3 w-3" />
                  <span>New Merchant Signup</span>
                </button>
              </div>
              <h2 className="mt-2 text-xl font-semibold text-slate-900">Sign in to Gateway Console</h2>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                    Work Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@takaledger.bd"
                    className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter account password"
                    className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>

                {error && (
                  <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
                >
                  {loading ? 'Signing in...' : 'Sign In'}
                </button>
              </form>

              {devQuickEnabled && (
                <div className="mt-8 pt-6 border-t border-slate-200">
                  <p className="text-xs font-medium text-slate-700">
                    Development Sandbox Access
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Launch either the Platform Admin Console or tenant-scoped Merchant Dashboard.
                  </p>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => handleDevRoleSignIn('SUPER_ADMIN')}
                      className="px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Super Admin
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => handleDevRoleSignIn('FINANCE_REVIEWER')}
                      className="px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Finance Reviewer
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => handleDevRoleSignIn('MERCHANT_ADMIN')}
                      className="px-3 py-2 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Merchant Portal
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
