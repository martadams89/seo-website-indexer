/**
 * Workspace context — the active tenant ("client base") the dashboard is
 * viewing. Loads the workspaces the signed-in user can access, keeps the
 * localStorage-backed active id in sync (so every API call carries the right
 * X-Workspace-Id), and exposes a switcher. Switching does a full reload so all
 * cached page data refetches under the new tenant — simple and leak-proof.
 *
 * Children only render once an active workspace is resolved, which guarantees
 * the header is set before AppProvider fires its first data fetch.
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { api, getActiveWorkspaceId, setActiveWorkspaceId, type Workspace } from '../api';

interface WorkspaceValue {
  workspaces: Workspace[];
  activeId: string | null;
  active: Workspace | null;
  switchWorkspace: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return v;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(getActiveWorkspaceId());
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const list = await api.getWorkspaces();
    setWorkspaces(list);
    // Reconcile the stored active id against what the user can actually access.
    const stored = getActiveWorkspaceId();
    const valid = stored && list.some(w => w.id === stored) ? stored
      : list.find(w => w.is_active)?.id ?? list[0]?.id ?? null;
    if (valid !== stored) setActiveWorkspaceId(valid);
    setActiveId(valid);
  }, []);

  useEffect(() => {
    load().catch(() => { /* no workspaces / not authed — render children anyway */ })
      .finally(() => setReady(true));
  }, [load]);

  const switchWorkspace = useCallback((id: string) => {
    if (id === getActiveWorkspaceId()) return;
    setActiveWorkspaceId(id);
    // Full reload: the cleanest way to refetch every page under the new tenant.
    window.location.reload();
  }, []);

  if (!ready) {
    return <div className="auth-screen"><Loader2 className="spin" size={22} /></div>;
  }

  const active = workspaces.find(w => w.id === activeId) ?? null;
  return (
    <WorkspaceContext.Provider value={{ workspaces, activeId, active, switchWorkspace, refreshWorkspaces: load }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
