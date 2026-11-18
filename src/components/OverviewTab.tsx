import { ArrowRight, ExternalLink, ShieldCheck } from 'lucide-react';
import { formatBdt, formatTimestamp } from '../lib/api.ts';
import type { PaymentIntentRow } from '../types/gateway.ts';
import { PaymentStatusLabel, ProviderLabel } from './StatusText.tsx';

export interface OverviewData {
  totals: {
    total_count: number;
    settled_volume_bdt: number;
    candidate_count: number;
    review_count: number;
    settled_count: number;
  };
  byProvider: Array<{
    provider: string;
    total_count: number;
    settled_bdt: number;
    pending_verification_count: number;
  }>;
  deviceStats: {
    active_devices: number;
    total_devices: number;
  };
  webhookStats: {
    delivered: number;
    total: number;
  };
  verificationQueue: PaymentIntentRow[];
}

interface OverviewTabProps {
  data: OverviewData | null;
  loading: boolean;
  onInspectPayment: (id: string) => void;
  onNavigateTab: (tab: 'payments' | 'devices' | 'notifications') => void;
}

export function OverviewTab({ data, loading, onInspectPayment, onNavigateTab }: OverviewTabProps) {
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((k) => (
            <div key={k} className="h-28 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  const totals = data?.totals ?? {
    total_count: 0,
    settled_volume_bdt: 0,
    candidate_count: 0,
    review_count: 0,
    settled_count: 0,
  };
  const deviceStats = data?.deviceStats ?? { active_devices: 0, total_devices: 0 };
  const webhookStats = data?.webhookStats ?? { delivered: 0, total: 0 };
  const webhookRate =
    webhookStats.total > 0 ? Math.round((webhookStats.delivered / webhookStats.total) * 100) : 100;

  return (
    <div className="space-y-6">
      {/* Compliance Notice Banner (Clean hairline, no border-l-4 cliché) */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-teal-700 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-slate-900">
              Two-Stage Verification Policy Active
            </p>
            <p className="text-xs text-slate-600 mt-0.5">
              Device notifications only flag candidate matches. Settlements require official Provider API confirmation or documented finance verification.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigateTab('payments')}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <span>Review Queue</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Verified Settled Volume</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {formatBdt(totals.settled_volume_bdt)}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            <span className="font-mono tabular-nums">{totals.settled_count}</span> of{' '}
            <span className="font-mono tabular-nums">{totals.total_count}</span> intents settled
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Awaiting Verification</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-amber-700">
            {Number(totals.candidate_count) + Number(totals.review_count)}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            <span className="font-mono tabular-nums">{totals.candidate_count}</span> candidate matched ·{' '}
            <span className="font-mono tabular-nums">{totals.review_count}</span> manual review
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Paired Android Agents</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {deviceStats.active_devices} / {deviceStats.total_devices}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            <button
              type="button"
              onClick={() => onNavigateTab('devices')}
              className="text-teal-700 hover:underline font-medium"
            >
              Manage device fleet
            </button>
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Signed Webhook Delivery</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {webhookRate}%
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            <span className="font-mono tabular-nums">{webhookStats.delivered}</span> delivered of{' '}
            <span className="font-mono tabular-nums">{webhookStats.total}</span> dispatches
          </p>
        </div>
      </div>

      {/* Provider Split */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Provider Breakdown</h2>
          <span className="text-xs text-slate-500">bKash · Nagad · DBBL Rocket</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200">
          {['BKASH', 'NAGAD', 'ROCKET'].map((prov) => {
            const stat = data?.byProvider.find((p) => p.provider === prov);
            return (
              <div key={prov} className="p-5 flex items-center justify-between">
                <div>
                  <ProviderLabel provider={prov} />
                  <p className="mt-2 text-lg font-semibold font-mono tabular-nums text-slate-900">
                    {formatBdt(stat?.settled_bdt ?? 0)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">{stat?.total_count ?? 0}</span> total intents
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-slate-500">Pending Review</p>
                  <p className="mt-1 text-base font-semibold font-mono tabular-nums text-amber-700">
                    {stat?.pending_verification_count ?? 0}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Priority Verification Queue */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Verification Queue</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Payments awaiting provider API confirmation or documented finance approval
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('payments')}
            className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
          >
            View All Intents
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Order / Merchant</th>
                <th className="py-2.5 px-4">Provider</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Submitted TrxID</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Updated</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {(data?.verificationQueue ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-xs text-slate-500">
                    All candidate matches have been verified or settled.
                  </td>
                </tr>
              ) : (
                (data?.verificationQueue ?? []).map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-mono text-xs font-medium text-slate-900">{p.merchant_order_id}</p>
                      <p className="text-xs text-slate-500">{p.merchant_name}</p>
                    </td>
                    <td className="py-3 px-4">
                      <ProviderLabel provider={p.provider} />
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                      {formatBdt(p.amount_bdt)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700">
                      {p.submitted_trx_id || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <PaymentStatusLabel status={p.status} />
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-500">
                      {formatTimestamp(p.updated_at)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <a
                          href={`/?checkout=${p.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1.5 text-slate-500 hover:text-slate-900 rounded"
                          title="Open Checkout Page"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => onInspectPayment(p.id)}
                          className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md whitespace-nowrap"
                        >
                          Inspect & Verify
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
    </div>
  );
}
