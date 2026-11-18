import { useState } from 'react';
import { Battery, CheckCircle2, Copy, Plus, QrCode, Smartphone, Wifi, X } from 'lucide-react';
import { apiFetch, formatTimestamp } from '../lib/api.ts';
import type { AuthUser, DeviceRow, MerchantRow, MfsWalletRow, ProviderCode } from '../types/gateway.ts';
import { ProviderLabel } from './StatusText.tsx';

interface DevicesTabProps {
  user: AuthUser;
  devices: DeviceRow[];
  merchants: MerchantRow[];
  wallets: MfsWalletRow[];
  onRefresh: () => void;
}

interface PairingResult {
  deviceId: string;
  deviceName: string;
  pairingCode: string;
  expiresAt: string;
  qrPayload: string;
  qrDataUrl: string;
}

export function DevicesTab({ user, devices, merchants, wallets, onRefresh }: DevicesTabProps) {
  const [showPairModal, setShowPairModal] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? '');
  const [selectedProviders, setSelectedProviders] = useState<ProviderCode[]>(['BKASH', 'NAGAD']);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [pairingResult, setPairingResult] = useState<PairingResult | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Test Android Handshake Simulator inside Pairing Modal
  const [simPairingDone, setSimPairingDone] = useState<string | null>(null);

  const canManage = user.role === 'SUPER_ADMIN' || user.role === 'OPERATIONS';

  function toggleProvider(p: ProviderCode) {
    setSelectedProviders((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  function toggleWallet(wId: string) {
    setSelectedWallets((prev) =>
      prev.includes(wId) ? prev.filter((x) => x !== wId) : [...prev, wId],
    );
  }

  async function handleGeneratePairing(e: React.FormEvent) {
    e.preventDefault();
    setPairError(null);
    setSimPairingDone(null);
    try {
      const res = await apiFetch<PairingResult>('/api/devices/pairing-code', {
        method: 'POST',
        body: JSON.stringify({
          deviceName,
          merchantId: merchantId || null,
          assignedProviders: selectedProviders,
          walletIds: selectedWallets,
        }),
      });
      setPairingResult(res);
      onRefresh();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Failed to generate pairing code');
    }
  }

  async function handleSimulateAndroidHandshake() {
    if (!pairingResult) return;
    try {
      const res = await apiFetch<{ deviceName: string; deviceId: string }>(
        '/api/devices/pair',
        {
          method: 'POST',
          body: JSON.stringify({
            pairingCode: pairingResult.pairingCode,
            deviceUid: `AND-SIM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
            androidModel: 'Samsung Galaxy A15 (Test Agent)',
            androidVersion: 'Android 14',
            appVersion: '1.4.2',
          }),
        },
        false,
      );
      setSimPairingDone(`Paired as ${res.deviceName} — HMAC & Keystore credentials issued.`);
      onRefresh();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Handshake simulation failed');
    }
  }

  async function handleUpdateDeviceStatus(deviceId: string, status: string) {
    await apiFetch(`/api/devices/${deviceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    onRefresh();
  }

  const merchantWallets = wallets.filter((w) => !merchantId || w.merchant_id === merchantId);

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Multi-Device Android Notification Agent Fleet
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Pair dedicated Android SIM devices using time-limited QR / pairing codes, assign MFS wallets, and monitor offline queue depth.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => {
              setPairingResult(null);
              setDeviceName('');
              setSimPairingDone(null);
              setShowPairModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>Pair Android Device</span>
          </button>
        )}
      </div>

      {/* Devices Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {devices.map((dev) => (
          <div key={dev.id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 bg-slate-100 rounded-lg text-slate-700">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{dev.device_name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {dev.merchant_name || 'Global Pool'} ·{' '}
                    <span className="font-mono">{dev.device_uid || 'Awaiting Handshake'}</span>
                  </p>
                </div>
              </div>

              <span
                className={`text-xs font-medium whitespace-nowrap ${
                  dev.status === 'ACTIVE'
                    ? 'text-emerald-700'
                    : dev.status === 'PENDING_PAIRING'
                      ? 'text-amber-700'
                      : 'text-rose-700'
                }`}
              >
                {dev.status}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 py-3 border-y border-slate-100 text-xs">
              <div>
                <p className="text-slate-500">Hardware / OS</p>
                <p className="mt-0.5 font-medium text-slate-900 truncate">
                  {dev.android_model || 'Pending'}
                </p>
                <p className="text-slate-500">{dev.android_version || '—'}</p>
              </div>
              <div>
                <p className="text-slate-500">Telemetry</p>
                <p className="mt-0.5 font-mono tabular-nums text-slate-900 inline-flex items-center gap-2">
                  <span className="inline-flex items-center gap-1">
                    <Battery className="h-3.5 w-3.5 text-slate-500" />
                    {dev.battery_pct !== null ? `${dev.battery_pct}%` : '—'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Wifi className="h-3.5 w-3.5 text-slate-500" />
                    {dev.network_type || '—'}
                  </span>
                </p>
                <p className="text-slate-500 font-mono tabular-nums">
                  Offline Queue: {dev.queue_depth}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Last Heartbeat</p>
                <p className="mt-0.5 font-mono tabular-nums text-slate-900">
                  {formatTimestamp(dev.last_heartbeat_at)}
                </p>
                {dev.pairing_code && (
                  <p className="font-mono text-amber-700 font-medium">Code: {dev.pairing_code}</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                {dev.assignedProviders.map((prov) => (
                  <ProviderLabel key={prov} provider={prov} />
                ))}
                {dev.assignedWallets.length > 0 && (
                  <span className="text-xs font-mono text-slate-500">
                    ({dev.assignedWallets.map((w) => w.account_number).join(', ')})
                  </span>
                )}
              </div>

              {canManage && (
                <div className="flex items-center gap-2">
                  {dev.status === 'ACTIVE' && (
                    <button
                      type="button"
                      onClick={() => handleUpdateDeviceStatus(dev.id, 'SUSPENDED')}
                      className="px-2.5 py-1 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md"
                    >
                      Suspend
                    </button>
                  )}
                  {dev.status === 'SUSPENDED' && (
                    <button
                      type="button"
                      onClick={() => handleUpdateDeviceStatus(dev.id, 'ACTIVE')}
                      className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md"
                    >
                      Activate
                    </button>
                  )}
                  {dev.status !== 'REVOKED' && (
                    <button
                      type="button"
                      onClick={() => handleUpdateDeviceStatus(dev.id, 'REVOKED')}
                      className="px-2.5 py-1 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-md"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Pair New Android Device Modal */}
      {showPairModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <QrCode className="h-4 w-4 text-teal-700" />
                <h3 className="text-base font-semibold text-slate-900">Pair New Android Device</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPairModal(false)}
                className="text-slate-500 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {!pairingResult ? (
              <form onSubmit={handleGeneratePairing} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Device Label</label>
                  <input
                    type="text"
                    required
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="e.g. Dhaka Mirpur SIM Node #3"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Assign Merchant</label>
                  <select
                    value={merchantId}
                    onChange={(e) => setMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Monitored MFS Providers
                  </label>
                  <div className="flex gap-2">
                    {(['BKASH', 'NAGAD', 'ROCKET'] as ProviderCode[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => toggleProvider(p)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                          selectedProviders.includes(p)
                            ? 'bg-teal-50 border-teal-700 text-teal-900'
                            : 'bg-white border-slate-200 text-slate-600'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Bind Receiving Wallets (Optional)
                  </label>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto border border-slate-200 rounded-lg p-2.5">
                    {merchantWallets.map((w) => (
                      <label key={w.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedWallets.includes(w.id)}
                          onChange={() => toggleWallet(w.id)}
                        />
                        <span className="font-mono">{w.provider} · {w.account_number}</span>
                        <span className="text-slate-500">({w.account_type})</span>
                      </label>
                    ))}
                  </div>
                </div>

                {pairError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{pairError}</p>}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowPairModal(false)}
                    className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                  >
                    Generate QR & Pairing Code
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row items-center gap-5 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                  <img
                    src={pairingResult.qrDataUrl}
                    alt="Device Pairing QR Code"
                    className="w-36 h-36 bg-white p-1.5 border border-slate-200 rounded-lg shrink-0"
                  />
                  <div className="space-y-2 text-center sm:text-left">
                    <p className="text-xs text-slate-500">One-Time Pairing Code (Expires in 15m)</p>
                    <div className="flex items-center justify-center sm:justify-start gap-2">
                      <span className="text-2xl font-mono font-semibold tracking-wider text-slate-900">
                        {pairingResult.pairingCode}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(pairingResult.pairingCode);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                        className="p-1.5 text-slate-500 hover:text-slate-900 rounded"
                        title="Copy pairing code"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    {copied && <p className="text-xs text-emerald-700">Pairing code copied</p>}
                    <p className="text-xs text-slate-600">
                      Open <strong>TakaLedger Agent</strong> on Android, grant Notification Listener access, and scan this QR or enter the pairing code.
                    </p>
                  </div>
                </div>

                {simPairingDone ? (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{simPairingDone}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleSimulateAndroidHandshake}
                    className="w-full py-2 px-3 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg"
                  >
                    Simulate Android Agent Handshake (Test Pairing)
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
