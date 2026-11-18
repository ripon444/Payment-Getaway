import { useEffect, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { apiFetch, setStoredToken } from '../lib/api.ts';
import type { AuthUser, UserRole } from '../types/gateway.ts';

interface LoginViewProps {
  onLoginSuccess: (user: AuthUser) => void;
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devQuickEnabled, setDevQuickEnabled] = useState(false);

  useEffect(() => {
    apiFetch<{ devQuickLoginEnabled: boolean }>('/api/auth/dev-mode', {}, false)
      .then((res) => setDevQuickEnabled(res.devQuickLoginEnabled))
      .catch(() => setDevQuickEnabled(false));
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

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="lg:col-span-5 bg-slate-900 text-slate-100 p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 text-emerald-400 text-sm font-medium">
              <ShieldCheck className="h-5 w-5" />
              <span>TakaLedger Gateway</span>
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white text-balance">
              Bangladesh Multi-Merchant MFS Payment Operations
            </h1>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              Manage bKash, Nagad, and DBBL Rocket payment intents, paired Android notification agents, candidate matching, and verified settlements.
            </p>
          </div>

          <div className="mt-10 pt-6 border-t border-slate-800 space-y-2.5 text-xs text-slate-300">
            <p className="font-medium text-white">Settlement Compliance Guardrails</p>
            <p>1. Android notifications create candidate matches only.</p>
            <p>2. Settlements require official Provider API verification or documented manual finance review.</p>
            <p>3. OTP and PIN notifications are redacted prior to ingestion.</p>
          </div>
        </div>

        <div className="lg:col-span-7 p-8 sm:p-10">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
            <Lock className="h-3.5 w-3.5" />
            <span>Authorized Operator Sign-In</span>
          </div>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">Sign in to Operations Console</h2>

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
                Quick-launch a role session without embedding credentials in client source code.
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
                  className="px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  Merchant Admin
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
