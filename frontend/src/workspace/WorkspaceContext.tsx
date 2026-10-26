/**
 * Workspace context — the active tenant ("client base") the dashboard is
 * viewing. The workspace lives in the URL (/w/<slug>/…): links from emails and
 * chat messages open in the right workspace, and each browser tab keeps its
 * own. Every API call carries it as X-Workspace-Id. A URL without a workspace
 * is sent to the one used last (or the first one). Switching navigates to the
 * other workspace's URL, which reloads so all page data refetches under the
 * new tenant — simple and leak-proof.
 *
 * Children only render once an active workspace is resolved, which guarantees
 * the header is set before AppProvider fires its first data fetch.
 */
import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { api, getActiveWorkspaceId, setActiveWorkspaceId, type Workspace } from '../api';
import { ROUTER_BASENAME, URL_WORKSPACE, workspacePath } from '../api/client';

interface WorkspaceValue {
  workspaces: Workspace[];
  activeId: string | null;
  active: Workspace | null;
  switchWorkspace: (id: string, slug?: string) => void;
  refreshWorkspaces: () => Promise<void>;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return v;
}

/** The path inside the app (without /w/<slug>), for carrying the current page across. */
function innerPath(): string {
  const path = window.location.pathname;
  return ROUTER_BASENAME && path.startsWith(ROUTER_BASENAME) ? path.slice(ROUTER_BASENAME.length) || '/' : path;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(getActiveWorkspaceId());
  const [ready, setReady] = useState(false);
  // The URL names a workspace this person can't open.
  const [missing, setMissing] = useState<string | null>(null);
  const latest = useRef<Workspace[]>([]);

  const load = useCallback(async () => {
    const list = await api.getWorkspaces();
    latest.current = list;
    setWorkspaces(list);
    if (URL_WORKSPACE) {
      const ref = URL_WORKSPACE.toLowerCase();
      const match = list.find(w => w.slug === ref || w.id === URL_WORKSPACE);
      if (!match) { setMissing(URL_WORKSPACE); return; }
      setActiveWorkspaceId(match.id);
      setActiveId(match.id);
      // An id in the URL (old link) is swapped for the readable slug.
      if (match.slug && ref !== match.slug) window.location.replace(`${workspacePath(match.slug, innerPath())}${window.location.search}${window.location.hash}`);
      return;
    }
    // No workspace in the URL: use the one this browser used last (or the first), and put it in the URL.
    const stored = getActiveWorkspaceId();
    const valid = (stored && list.find(w => w.id === stored)) || list.find(w => w.is_active) || list[0] || null;
    setActiveWorkspaceId(valid?.id ?? null);
    setActiveId(valid?.id ?? null);
    if (valid?.slug) {
      window.location.replace(`${workspacePath(valid.slug, window.location.pathname)}${window.location.search}${window.location.hash}`);
      await new Promise(() => { /* keep the spinner up while the browser navigates */ });
    }
  }, []);

  useEffect(() => {
    load().catch(() => { /* no workspaces / not authed — render children anyway */ })
      .finally(() => setReady(true));
  }, [load]);

  const switchWorkspace = useCallback((id: string, slug?: string) => {
    if (id === getActiveWorkspaceId() && !slug) return;
    const target = slug ?? latest.current.find(w => w.id === id)?.slug;
    setActiveWorkspaceId(id);
    if (!target) { window.location.reload(); return; }
    // Keep the section (and tab) you were on; anything specific to the old workspace (an id in the path) is dropped.
    const section = `/${innerPath().split('/')[1] ?? ''}`;
    const tab = new URLSearchParams(window.location.search).get('tab');
    window.location.assign(`${workspacePath(target, section)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`);
  }, []);

  if (!ready) {
    return <div className="auth-screen"><Loader2 className="spin" size={22} /></div>;
  }

  if (missing) {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ maxWidth: 440 }}>
          <Building2 size={22} />
          <h1 style={{ fontSize: 18, margin: '10px 0 6px' }}>You can't open this workspace</h1>
          <p className="text-dim" style={{ fontSize: 13 }}>
            The link is for <code>{missing}</code>, which doesn't exist or isn't shared with you. Ask its owner to invite you, or open one of yours:
          </p>
          <div className="flex-col gap-2" style={{ marginTop: 12 }}>
            {workspaces.map(w => <a key={w.id} className="btn btn-secondary" href={workspacePath(w.slug ?? w.id, innerPath())}>{w.name}</a>)}
          </div>
        </div>
      </div>
    );
  }

  const active = workspaces.find(w => w.id === activeId) ?? null;
  return (
    <WorkspaceContext.Provider value={{ workspaces, activeId, active, switchWorkspace, refreshWorkspaces: load }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
