/**
 * Sidebar workspace switcher — shows the active tenant and lets the user jump
 * between the workspaces they can access (or create a new one). Switching
 * reloads the app under the chosen tenant (see WorkspaceContext).
 */
import { useState, useRef, useEffect } from 'react';
import { Building2, Check, ChevronsUpDown, Plus, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useWorkspace } from './WorkspaceContext';

export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspaces, active, activeId, switchWorkspace, refreshWorkspaces } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setCreating(false); }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ws = await api.createWorkspace(name.trim());
      await refreshWorkspaces();
      setName('');
      setCreating(false);
      switchWorkspace(ws.id); // reloads into the new workspace
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-switcher" ref={ref}>
      <button
        type="button"
        className="ws-switcher-trigger"
        onClick={() => setOpen(o => !o)}
        title={collapsed ? (active?.name ?? 'Workspace') : undefined}
      >
        <Building2 size={15} style={{ flexShrink: 0 }} />
        <span className="ws-switcher-name nav-item-label">{active?.name ?? 'No workspace'}</span>
        <ChevronsUpDown size={13} style={{ flexShrink: 0, opacity: 0.6 }} className="nav-item-label" />
      </button>

      {open && (
        <div className="ws-switcher-menu">
          <div className="ws-switcher-menu-label">Workspaces</div>
          {workspaces.map(w => (
            <button
              key={w.id}
              type="button"
              className={`ws-switcher-item${w.id === activeId ? ' active' : ''}`}
              onClick={() => { setOpen(false); switchWorkspace(w.id); }}
            >
              <span className="truncate">{w.name}</span>
              {w.id === activeId && <Check size={14} style={{ flexShrink: 0 }} />}
            </button>
          ))}

          {creating ? (
            <div className="ws-switcher-create">
              <input
                className="input"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') create(); }}
                placeholder="Workspace name"
                autoFocus
              />
              <button className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
                {busy ? <Loader2 className="spin" size={13} /> : 'Add'}
              </button>
            </div>
          ) : (
            <button type="button" className="ws-switcher-item ws-switcher-new" onClick={() => setCreating(true)}>
              <Plus size={14} /> New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
