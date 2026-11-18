import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw, Send } from 'lucide-react';
import { apiFetch, formatBdt, formatTimestamp } from '../lib/api.ts';
import type { AuthUser, DeviceRow, NotificationEventRow } from '../types/gateway.ts';
import { ParseStatusLabel, ProviderLabel } from './StatusText.tsx';

interface NotificationsTabProps {
  user: AuthUser;
  devices: DeviceRow[];
  onDataChanged: () => void;
}

const SAMPLE_TEMPLATES = [
  {
    label: 'bKash Payment',
    pkg: 'com.bKash.customerapp',
    title: 'bKash Payment Received',
    body: 'You have received payment Tk 1,250.00 from 01711889900. Fee Tk 0.00. Balance Tk 44,900.00. TrxID BKH7721K9P.',
  },
  {
    label: 'Nagad Received',
    pkg: 'com.konasl.nagad',
    title: 'Nagad Money Received',
    body: 'Money Received. Amount: Tk 2500.00 Sender: 01812334455 Ref: DC98425. TxnID: 71NGD5521A. Balance: Tk 31,900.00',
  },
  {
    label: 'Rocket Cash-In',
    pkg: 'com.dbbl.mfs.rocket',
    title: 'DBBL Rocket Alert',
    body: 'Tk1,500.00 received from A/C 01688990011 Fee: Tk0.00 TxnId: RKT88123344. Balance: Tk20,400.00',
  },
  {
    label: 'OTP Security Filter Test',
    pkg: 'com.bKash.customerapp',
    title: 'bKash Verification',
    body: 'Your bKash One Time Password OTP is 849201. Never share your PIN or OTP with anyone.',
  },
];

export function NotificationsTab({ user, devices, onDataChanged }: NotificationsTabProps) {
  const [events, setEvents] = useState<NotificationEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Sandbox state
  const activeDevices = devices.filter((d) => d.status === 'ACTIVE');
  const [simDeviceId, setSimDeviceId] = useState(activeDevices[0]?.id ?? '');
  const [simPkg, setSimPkg] = useState(SAMPLE_TEMPLATES[0].pkg);
  const [simTitle, setSimTitle] = useState(SAMPLE_TEMPLATES[0].title);
  const [simBody, setSimBody] = useState(SAMPLE_TEMPLATES[0].body);
  const [previewResult, setPreviewResult] = useState<Record<string, unknown> | null>(null);
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  useEffect(() => {
    if (!simDeviceId && activeDevices.length > 0) {
      setSimDeviceId(activeDevices[0].id);
    }
  }, [activeDevices, simDeviceId]);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ notifications: NotificationEventRow[] }>('/api/notifications');
      setEvents(res.notifications);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  async function handleDryRunParse() {
    setSimBusy(true);
    setSimResult(null);
    try {
      const res = await apiFetch<{ parsed: Record<string, unknown> }>('/api/notifications/parse-preview', {
        method: 'POST',
        body: JSON.stringify({ packageName: simPkg, title: simTitle, body: simBody }),
      });
      setPreviewResult(res.parsed);
    } finally {
      setSimBusy(false);
    }
  }

  async function handleSimulateIngest() {
    if (!simDeviceId) return;
    setSimBusy(true);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/notifications/simulate-device-ingest', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: simDeviceId,
          packageName: simPkg,
          title: simTitle,
          body: simBody,
        }),
      });
      setSimResult(res);
      await loadNotifications();
      onDataChanged();
    } finally {
      setSimBusy(false);
    }
  }

  const canSimulate = user.role === 'SUPER_ADMIN' || user.role === 'OPERATIONS';

  return (
    <div className="space-y-6">
      {/* Parser Testbench & Device Ingest Simulator */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Provider Parser Sandbox & Notification Simulator
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Test separate bKash, Nagad, and Rocket parser modules, OTP redaction, and candidate matching without auto-settling.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                type="button"
                onClick={() => {
                  setSimPkg(tpl.pkg);
                  setSimTitle(tpl.title);
                  setSimBody(tpl.body);
                  setPreviewResult(null);
                  setSimResult(null);
                }}
                className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Android Package</label>
                <select
                  value={simPkg}
                  onChange={(e) => setSimPkg(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                >
                  <option value="com.bKash.customerapp">com.bKash.customerapp</option>
                  <option value="com.konasl.nagad">com.konasl.nagad</option>
                  <option value="com.dbbl.mfs.rocket">com.dbbl.mfs.rocket</option>
                  <option value="com.google.android.apps.messaging">SMS Messaging</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Source Paired Device</label>
                <select
                  value={simDeviceId}
                  onChange={(e) => setSimDeviceId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                >
                  {activeDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.device_name} ({d.device_uid})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Notification Body</label>
              <textarea
                rows={3}
                value={simBody}
                onChange={(e) => setSimBody(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={simBusy}
                onClick={handleDryRunParse}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg"
              >
                <Play className="h-3.5 w-3.5" />
                <span>Dry-Run Parser</span>
              </button>
              {canSimulate && (
                <button
                  type="button"
                  disabled={simBusy || !simDeviceId}
                  onClick={handleSimulateIngest}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Ingest via Device & Run Matcher</span>
                </button>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 bg-slate-900 text-slate-100 rounded-lg p-4 font-mono text-xs overflow-auto max-h-60">
            <p className="text-slate-400 mb-2">
              {simResult ? 'Device Ingestion + Matching Output' : 'Parser Dry-Run Output'}
            </p>
            <pre className="whitespace-pre-wrap break-words text-emerald-300">
              {JSON.stringify(simResult ?? previewResult ?? { ready: 'Run parser or ingest simulation' }, null, 2)}
            </pre>
          </div>
        </div>
      </div>

      {/* Live Notification Events Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Ingested Notification Events</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Deduplicated MFS alerts from paired Android devices (OTP/PIN payloads stripped)
            </p>
          </div>
          <button
            type="button"
            onClick={loadNotifications}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Device</th>
                <th className="py-2.5 px-4">Provider</th>
                <th className="py-2.5 px-4">Parsed TrxID</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Sender</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Redacted Payload</th>
                <th className="py-2.5 px-4">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    Loading notification events...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    No notification events ingested yet.
                  </td>
                </tr>
              ) : (
                events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{ev.device_name || ev.device_id}</p>
                      <p className="font-mono text-slate-500">{ev.package_name}</p>
                    </td>
                    <td className="py-3 px-4">
                      <ProviderLabel provider={ev.provider} />
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-900">
                      {ev.parsed_trx_id || '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                      {ev.parsed_amount_bdt !== null ? formatBdt(ev.parsed_amount_bdt) : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-700">
                      {ev.parsed_sender_phone || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <ParseStatusLabel status={ev.parse_status} />
                    </td>
                    <td className="py-3 px-4 max-w-xs truncate font-mono text-slate-600" title={ev.raw_body_redacted}>
                      {ev.raw_body_redacted}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatTimestamp(ev.received_at)}
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
