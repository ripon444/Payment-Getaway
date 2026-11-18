import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BellRing,
  Building2,
  CreditCard,
  LogOut,
  Menu,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { CheckoutPage } from './components/CheckoutPage.tsx';
import { DevicesTab } from './components/DevicesTab.tsx';
import { FraudHealthTab } from './components/FraudHealthTab.tsx';
import { LoginView } from './components/LoginView.tsx';
import { MerchantsTab } from './components/MerchantsTab.tsx';
import { NotificationsTab } from './components/NotificationsTab.tsx';
import { OverviewTab, type OverviewData } from './components/OverviewTab.tsx';
import { PaymentsTab } from './components/PaymentsTab.tsx';
import { ProvidersQrTab } from './components/ProvidersQrTab.tsx';
import { SecurityAuditTab } from './components/SecurityAuditTab.tsx';
import { apiFetch, getStoredToken, setStoredToken } from './lib/api.ts';
import { createGatewaySocket } from './lib/socket.ts';
import type {
  AuthUser,
  DeviceRow,
  MerchantRow,
  MerchantWebsiteRow,
  MfsWalletRow,
} from './types/gateway.ts';

type NavTab =
  | 'overview'
  | 'payments'
  | 'providers'
  | 'notifications'
  | 'devices'
  | 'merchants'
  | 'fraud'
  | 'security';

const ADMIN_NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'payments', label: 'Payments & Matching', icon: CreditCard },
  { id: 'providers', label: 'Bangla QR & Providers', icon: QrCode },
  { id: 'notifications', label: 'SMS & Notification Parsers', icon: BellRing },
  { id: 'devices', label: 'Android Devices', icon: Smartphone },
  { id: 'merchants', label: 'Merchants & Websites', icon: Building2 },
  { id: 'fraud', label: 'Fraud, Usage & Health', icon: ShieldAlert },
  { id: 'security', label: 'Users & Audit Logs', icon: ShieldCheck },
];

const MERCHANT_NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Merchant Overview', icon: Activity },
  { id: 'payments', label: 'Orders & Sessions', icon: CreditCard },
  { id: 'merchants', label: 'Websites, API & Webhooks', icon: Building2 },
  { id: 'devices', label: 'My Android Nodes', icon: Smartphone },
  { id: 'notifications', label: 'Incoming Alerts', icon: BellRing },
  { id: 'fraud', label: 'API Usage & Alerts', icon: ShieldAlert },
];

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const checkoutPaymentId = params.get('checkout');

  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [wallets, setWallets] = useState<MfsWalletRow[]>([]);
  const [websites, setWebsites] = useState<MerchantWebsiteRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  useEffect(() => {
    if (checkoutPaymentId) {
      setAuthChecked(true);
      return;
    }
    const token = getStoredToken();
    if (!token) {
      setAuthChecked(true);
      return;
    }
    apiFetch<{ user: AuthUser }>('/api/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setStoredToken(null))
      .finally(() => setAuthChecked(true));
  }, [checkoutPaymentId]);

  const loadWorkspaceData = useCallback(async () => {
    if (!user) return;
    setLoadingData(true);
    try {
      const [ovRes, mRes, dRes] = await Promise.all([
        apiFetch<OverviewData>('/api/overview'),
        apiFetch<{ merchants: MerchantRow[]; wallets: MfsWalletRow[]; websites?: MerchantWebsiteRow[] }>('/api/merchants'),
        apiFetch<{ devices: DeviceRow[] }>('/api/devices'),
      ]);
      setOverview(ovRes);
      setMerchants(mRes.merchants);
      setWallets(mRes.wallets);
      setWebsites(mRes.websites ?? []);
      setDevices(dRes.devices);
    } finally {
      setLoadingData(false);
    }
  }, [user]);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  useEffect(() => {
    if (!user) return;
    const socket = createGatewaySocket();
    socket.on('connect', () => setLiveConnected(true));
    socket.on('disconnect', () => setLiveConnected(false));

    const handleRefresh = () => {
      loadWorkspaceData();
    };
    socket.on('payment:updated', handleRefresh);
    socket.on('notification:ingested', handleRefresh);
    socket.on('device:telemetry', handleRefresh);
    socket.on('fraud:alert', handleRefresh);

    return () => {
      socket.disconnect();
      setLiveConnected(false);
    };
  }, [user, loadWorkspaceData]);

  if (checkoutPaymentId) {
    return <CheckoutPage paymentId={checkoutPaymentId} />;
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-xs text-slate-500">
        Initializing gateway console...
      </div>
    );
  }

  if (!user) {
    return <LoginView onLoginSuccess={(u) => setUser(u)} />;
  }

  function handleLogout() {
    setStoredToken(null);
    setUser(null);
    setActiveTab('overview');
  }

  function handleInspectPayment(id: string) {
    setSelectedPaymentId(id);
    setActiveTab('payments');
  }

  const isMerchantView = user.role === 'MERCHANT_ADMIN';
  const navItems = isMerchantView ? MERCHANT_NAV_ITEMS : ADMIN_NAV_ITEMS;
  const currentNavLabel = navItems.find((n) => n.id === activeTab)?.label ?? 'Overview';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col bg-white border-r border-slate-200 shrink-0">
        <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-teal-700 shrink-0" />
            <span className="font-display font-semibold text-base tracking-tight text-slate-900 whitespace-nowrap">
              TakaLedger
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            {isMerchantView ? 'MERCHANT' : 'ADMIN'}
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-teal-50 text-teal-800'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-2.5">
          <div>
            <p className="text-xs font-medium text-slate-900 truncate">{user.fullName}</p>
            <p className="text-xs font-mono text-slate-500 truncate">{user.role}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative w-64 bg-white h-full flex flex-col border-r border-slate-200 z-10">
            <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between">
              <span className="font-display font-semibold text-base text-slate-900">TakaLedger</span>
              <button type="button" onClick={() => setMobileNavOpen(false)}>
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg ${
                      activeTab === item.id ? 'bg-teal-50 text-teal-800' : 'text-slate-600'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
              >
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-lg"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="text-xs text-slate-500 flex items-center gap-2 truncate">
              <span className="hidden sm:inline">
                {isMerchantView ? 'Merchant Portal' : 'Gateway Admin Console'}
              </span>
              <span className="hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-900 truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs font-mono text-slate-500">
              {liveConnected ? 'Socket.IO Live' : 'Polling'}
            </span>
            <button
              type="button"
              onClick={loadWorkspaceData}
              disabled={loadingData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              <span>Sync Ledger</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewTab
              data={overview}
              loading={loadingData}
              isMerchantView={isMerchantView}
              onInspectPayment={handleInspectPayment}
              onNavigateTab={(t) => setActiveTab(t)}
            />
          )}
          {activeTab === 'payments' && (
            <PaymentsTab
              user={user}
              merchants={merchants}
              selectedPaymentId={selectedPaymentId}
              onSelectPayment={setSelectedPaymentId}
              onDataChanged={loadWorkspaceData}
            />
          )}
          {activeTab === 'providers' && <ProvidersQrTab user={user} />}
          {activeTab === 'notifications' && (
            <NotificationsTab
              user={user}
              devices={devices}
              onDataChanged={loadWorkspaceData}
            />
          )}
          {activeTab === 'devices' && (
            <DevicesTab
              user={user}
              devices={devices}
              merchants={merchants}
              wallets={wallets}
              onRefresh={loadWorkspaceData}
            />
          )}
          {activeTab === 'merchants' && (
            <MerchantsTab
              user={user}
              merchants={merchants}
              wallets={wallets}
              websites={websites}
              onRefresh={loadWorkspaceData}
            />
          )}
          {activeTab === 'fraud' && <FraudHealthTab user={user} />}
          {activeTab === 'security' && (
            <SecurityAuditTab user={user} merchants={merchants} />
          )}
        </main>
      </div>
    </div>
  );
}
