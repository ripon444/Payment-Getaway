import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Cpu, RefreshCw, ShieldAlert } from 'lucide-react';
import { apiFetch, formatTimestamp } from '../lib/api.ts';
import type {
  ApiUsageLogRow,
  ApiUsageSummaryRow,
  AuthUser,
  FraudAlertRow,
  SystemHealthData,
} from '../types/gateway.ts';

interface FraudHealthTabProps {
  user: AuthUser;
}

export function FraudHealthTab({ user }: FraudHealthTabProps) {
  const [alerts, setAlerts] = useState<FraudAlertRow[]>([]);
  const [usageLogs, setUsageLogs] = useState<ApiUsageLogRow[]>([]);
  const [usageSummary, setUsageSummary] = useState<ApiUsageSummaryRow[]>([]);
  const [health, setHealth] = useState<SystemHealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const canResolveFraud = user.role === 'SUPER_ADMIN' || user.role === 'FINANCE_REVIEWER';
  const canViewHealth = user.role !== 'MERCHANT_ADMIN';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [fRes, uRes, hRes] = await Promise.all([
        apiFetch<{ alerts: FraudAlertRow[] }>('/api/fraud-alerts'),
        apiFetch<{ logs: ApiUsageLogRow[]; summary: ApiUsageSummaryRow[] }>('/api/usage-stats'),
        canViewHealth ? apiFetch<SystemHealthData>('/api/system-health') : Promise.resolve(null),
      ]);
      setAlerts(fRes.alerts);
      setUsageLogs(uRes.logs);
      setUsageSummary(uRes.summary);
      setHealth(hRes);
    } finally {
      setLoading(false);
    }
  }, [canViewHealth]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleUpdateAlert(id: string, status: 'ACKNOWLEDGED' | 'RESOLVED') {
    await apiFetch(`/api/fraud-alerts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadData();
  }

  return (
    <div className="space-y-6">
      {/* System Health Bar */}
      {health && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Activity className="h-3.5 w-3.5 text-emerald-700" />
              <span>Database & Engine</span>
            </div>
            <p className="mt-2 text-base font-semibold font-mono text-slate-900">
              {health.ok ? 'HEALTHY' : 'DEGRADED'} ({health.dialect.toUpperCase()})
            </p>
            <p className="mt-0.5 text-xs font-mono text-slate-500">{health.nodeVersion}</p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Cpu className="h-3.5 w-3.5 text-slate-600" />
              <span>Process Memory (RSS)</span>
            </div>
            <p className="mt-2 text-base font-semibold font-mono tabular-nums text-slate-900">
              {health.memoryMb} MB
            </p>
            <p className="mt-0.5 text-xs font-mono tabular-nums text-slate-500">
              Uptime: {health.uptimeSec}s
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">CPU Load Average</p>
            <p className="mt-2 text-base font-semibold font-mono tabular-nums text-slate-900">
              {health.loadAvg.join(' / ')}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">1m · 5m · 15m</p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-700" />
              <span>Open Fraud Alerts</span>
            </div>
            <p className="mt-2 text-base font-semibold font-mono tabular-nums text-amber-700">
              {alerts.filter((a) => a.status === 'OPEN').length}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">Duplicate TrxID & Amount Guards</p>
          </div>
        </div>
      )}

      {/* Fraud Alerts Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Fraud & Duplicate Detection Alerts</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Raised automatically when duplicate TrxIDs, amount mismatches, or suspicious alerts are blocked
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
                <th className="py-2.5 px-4">Type / Severity</th>
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Summary</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Created</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    No fraud alerts recorded.
                  </td>
                </tr>
              ) : (
                alerts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-mono font-medium text-slate-900">{a.alert_type}</p>
                      <p
                        className={`font-mono text-xs ${
                          a.severity === 'HIGH' || a.severity === 'CRITICAL'
                            ? 'text-rose-700 font-semibold'
                            : 'text-amber-700'
                        }`}
                      >
                        {a.severity}
                      </p>
                    </td>
                    <td className="py-3 px-4 text-slate-700">{a.merchant_name || 'Global'}</td>
                    <td className="py-3 px-4 text-slate-700 max-w-md">{a.summary}</td>
                    <td className="py-3 px-4 font-mono">
                      <span
                        className={
                          a.status === 'OPEN'
                            ? 'inline-flex items-center gap-1 text-rose-700 font-medium'
                            : a.status === 'ACKNOWLEDGED'
                              ? 'text-amber-700 font-medium'
                              : 'text-emerald-700 font-medium'
                        }
                      >
                        {a.status === 'OPEN' && <AlertTriangle className="h-3.5 w-3.5" />}
                        {a.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatTimestamp(a.created_at)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {canResolveFraud && a.status !== 'RESOLVED' && (
                        <div className="inline-flex items-center gap-1.5">
                          {a.status === 'OPEN' && (
                            <button
                              type="button"
                              onClick={() => handleUpdateAlert(a.id, 'ACKNOWLEDGED')}
                              className="px-2.5 py-1 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md"
                            >
                              Acknowledge
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleUpdateAlert(a.id, 'RESOLVED')}
                            className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md"
                          >
                            Resolve
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

      {/* Merchant API Usage Statistics */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Merchant API v1 Usage & Latency</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Real request telemetry from /api/v1/methods, /api/v1/payments, and status queries
          </p>
        </div>

        {usageSummary.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 border-b border-slate-200">
            {usageSummary.map((s) => (
              <div key={s.endpoint} className="p-4">
                <p className="font-mono text-xs text-slate-600">{s.endpoint}</p>
                <p className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
                  {s.calls} calls{' '}
                  <span className="text-xs font-normal text-slate-500">
                    ({Math.round(Number(s.avg_latency_ms || 0))}ms avg)
                  </span>
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Merchant</th>
                <th className="py-2.5 px-4">Endpoint</th>
                <th className="py-2.5 px-4 text-right">Status</th>
                <th className="py-2.5 px-4 text-right">Latency</th>
                <th className="py-2.5 px-4">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {usageLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No Merchant API v1 requests logged yet.
                  </td>
                </tr>
              ) : (
                usageLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50/80">
                    <td className="py-2.5 px-4 text-slate-900 font-medium">{l.merchant_name}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-700">{l.method} {l.endpoint}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{l.status_code}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{l.latency_ms} ms</td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500">{formatTimestamp(l.created_at)}</td>
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
