import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Shield, X } from 'lucide-react';
import { apiFetch, formatTimestamp } from '../lib/api.ts';
import type { AuditLogRow, AuthUser, MerchantRow, UserRole } from '../types/gateway.ts';

interface PlatformUserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  merchant_id: string | null;
  merchant_name: string | null;
  is_active: number;
  last_login_at: string | null;
}

interface SecurityAuditTabProps {
  user: AuthUser;
  merchants: MerchantRow[];
}

export function SecurityAuditTab({ user, merchants }: SecurityAuditTabProps) {
  const [users, setUsers] = useState<PlatformUserRow[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [showAddUser, setShowAddUser] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('FINANCE_REVIEWER');
  const [newMerchantId, setNewMerchantId] = useState('');
  const [userError, setUserError] = useState<string | null>(null);

  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const canViewAudit = user.role === 'SUPER_ADMIN' || user.role === 'FINANCE_REVIEWER';

  const loadData = useCallback(async () => {
    if (isSuperAdmin) {
      const uRes = await apiFetch<{ users: PlatformUserRow[] }>('/api/auth/users');
      setUsers(uRes.users);
    }
    if (canViewAudit) {
      const qs = actionFilter.trim() ? `?action=${encodeURIComponent(actionFilter.trim())}` : '';
      const aRes = await apiFetch<{ logs: AuditLogRow[] }>(`/api/audit-logs${qs}`);
      setLogs(aRes.logs);
    }
  }, [isSuperAdmin, canViewAudit, actionFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setUserError(null);
    try {
      await apiFetch('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newEmail,
          fullName: newName,
          password: newPassword,
          role: newRole,
          merchantId: newRole === 'MERCHANT_ADMIN' ? newMerchantId || merchants[0]?.id : null,
        }),
      });
      setShowAddUser(false);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      await loadData();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : 'Could not create user');
    }
  }

  async function handleToggleActive(target: PlatformUserRow) {
    await apiFetch(`/api/auth/users/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: Number(target.is_active) !== 1 }),
    });
    await loadData();
  }

  return (
    <div className="space-y-6">
      {isSuperAdmin && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">RBAC Users & Operators</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Least-privilege access controls across Super Admin, Finance Reviewer, Operations, and Merchant Admin roles
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddUser(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Operator</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Operator</th>
                  <th className="py-2.5 px-4">Role</th>
                  <th className="py-2.5 px-4">Merchant Scope</th>
                  <th className="py-2.5 px-4">Last Login</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{u.full_name}</p>
                      <p className="font-mono text-slate-500">{u.email}</p>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-800">{u.role}</td>
                    <td className="py-3 px-4 text-slate-600">{u.merchant_name || 'Platform Global'}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                      {formatTimestamp(u.last_login_at)}
                    </td>
                    <td className="py-3 px-4">
                      <span className={Number(u.is_active) === 1 ? 'text-emerald-700 font-medium' : 'text-rose-700 font-medium'}>
                        {Number(u.is_active) === 1 ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {u.id !== user.id && (
                        <button
                          type="button"
                          onClick={() => handleToggleActive(u)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          {Number(u.is_active) === 1 ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canViewAudit ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Immutable Financial & Security Audit Log</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Every login, device pairing, duplicate block, candidate match, and settlement verification
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                placeholder="Filter action (e.g. VERIFIED)"
                className="px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
              />
              <button
                type="button"
                onClick={loadData}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">State Snapshot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatTimestamp(log.created_at)}
                    </td>
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{log.actor_email || log.actor_id}</p>
                      <p className="font-mono text-slate-500">{log.actor_type} · {log.ip_address || 'local'}</p>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-900">{log.action}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">
                      {log.resource_type}:{log.resource_id.slice(0, 8)}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 max-w-sm truncate" title={log.after_state_json || ''}>
                      {log.after_state_json || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
          <Shield className="h-8 w-8 text-slate-400 mx-auto" />
          <p className="mt-3 text-sm font-medium text-slate-900">Restricted Security & Audit View</p>
          <p className="mt-1 text-xs text-slate-500">
            Audit logs and operator management require SUPER_ADMIN or FINANCE_REVIEWER privileges.
          </p>
        </div>
      )}

      {/* Add User Modal */}
      {showAddUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Create RBAC Operator</h3>
              <button type="button" onClick={() => setShowAddUser(false)}>
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Password (min 8 chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                >
                  <option value="FINANCE_REVIEWER">FINANCE_REVIEWER</option>
                  <option value="OPERATIONS">OPERATIONS</option>
                  <option value="MERCHANT_ADMIN">MERCHANT_ADMIN</option>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
              </div>
              {newRole === 'MERCHANT_ADMIN' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merchant</label>
                  <select
                    value={newMerchantId}
                    onChange={(e) => setNewMerchantId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  >
                    {merchants.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {userError && <p className="text-xs text-rose-700 bg-rose-50 p-2 rounded">{userError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddUser(false)} className="px-3 py-2 text-xs bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg">
                  Create Operator
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
