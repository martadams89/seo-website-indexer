import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ScrollText, Settings, Zap, AlertTriangle, Activity,
  ChevronLeft, ChevronRight, Menu, X, Sun, Moon, WifiOff, LogOut,
  BarChart3, Search, Command, ArrowRight,
  Layers3, PlugZap, FileOutput, ShieldCheck, Send, MapPin, Eye, BriefcaseBusiness,
} from 'lucide-react';
import { useApp } from './AppContext';
import { useAuth } from './auth/AuthGate';
import { useWorkspace } from './workspace/WorkspaceContext';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
import { createLogStream } from './api';
import { ToastHost } from './components/Toast';

// ── Sidebar Nav ───────────────────────────────────────────────────────────────

type ExperienceMode = 'core' | 'growth' | 'agency';
type NavItem = { to: string; icon: typeof Activity; label: string; detail: string; minimum?: ExperienceMode };
const MODE_RANK: Record<ExperienceMode, number> = { core: 0, growth: 1, agency: 2 };
const PRIMARY_NAV: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Overview', detail: 'Health, priorities and progress' },
  { to: '/sites', icon: Globe, label: 'Sites', detail: 'Indexing and site workspaces' },
  { to: '/actions', icon: BriefcaseBusiness, label: 'Work', detail: 'Owned actions and remediation' },
  { to: '/insights', icon: BarChart3, label: 'Insights', detail: 'Search, AI and connected evidence' },
  { to: '/reports', icon: FileOutput, label: 'Reports', detail: 'Snapshots and executive reporting' },
];
const ADVANCED_NAV: NavItem[] = [
  { to: '/integrations', icon: PlugZap, label: 'Connections', detail: 'Data and delivery integrations' },
  { to: '/logs', icon: ScrollText, label: 'Full activity log', detail: 'Detailed system diagnostics' },
  { to: '/publishing', icon: Send, label: 'Publishing', detail: 'Reviewed CMS changes', minimum: 'growth' },
  { to: '/insights/entities', icon: MapPin, label: 'Markets & entities', detail: 'Identity evidence', minimum: 'growth' },
  { to: '/executive-view', icon: Eye, label: 'Executive view', detail: 'Read-only workspace summary', minimum: 'agency' },
  { to: '/governance', icon: ShieldCheck, label: 'Governance & usage', detail: 'Budgets, policies and automation', minimum: 'agency' },
];
const SETTINGS_NAV: NavItem = { to: '/settings', icon: Settings, label: 'Settings', detail: 'Account, workspace and platform' };
const ALL_NAV = [...PRIMARY_NAV, ...ADVANCED_NAV, SETTINGS_NAV];

function modeLabel(mode: ExperienceMode): string {
  return mode === 'core' ? 'Core' : mode === 'growth' ? 'Growth' : 'Agency';
}

// ── Layout Component ──────────────────────────────────────────────────────────

export default function Layout() {
  const { status, sites, logs, appendLog, theme, toggleTheme, sseConnected, markSseAlive } = useApp();
  const { user, logout, stopImpersonating } = useAuth();
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('organic:sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false); // mobile drawer open
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>(() => {
    const saved = localStorage.getItem('organic:experience-mode');
    return saved === 'growth' || saved === 'agency' ? saved : 'core';
  });
  const [toolsOpen, setToolsOpen] = useState(() => experienceMode !== 'core');
  const commandRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const visibleAdvanced = useMemo(() => ADVANCED_NAV.filter(item => MODE_RANK[experienceMode] >= MODE_RANK[item.minimum ?? 'core']), [experienceMode]);
  const commandItems = useMemo(() => [
    ...ALL_NAV.map(item => ({ label: item.label, detail: item.detail, to: item.to, icon: item.icon })),
    ...sites.map(site => ({ label: site.name, detail: site.domain, to: `/sites/${site.id}`, icon: Globe })),
  ].filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(commandQuery.trim().toLowerCase())).slice(0, 10), [commandQuery, sites]);

  function openCommandItem(to: string) {
    navigate(to);
    setCommandOpen(false);
    setCommandQuery('');
  }

  // Only force the Google-auth setup wizard on a genuinely empty workspace —
  // a member invited into a workspace that already has sites/content should
  // never be dropped into onboarding, and a read-only viewer couldn't act on
  // it anyway.
  const isViewer = active?.role === 'viewer' && !user.is_super_admin;
  const needsSetup = !!status && !status.auth.authenticated && sites.length === 0 && !isViewer;

  // Redirect to onboarding if not configured
  useEffect(() => {
    if (needsSetup && window.location.pathname !== '/setup') {
      navigate('/setup');
    }
  }, [needsSetup, navigate]);

  // SSE connection for live logs
  useEffect(() => {
    const disconnect = createLogStream(appendLog, markSseAlive);
    return disconnect;
  }, [appendLog, markSseAlive]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Lock body scroll while mobile drawer is open
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setCommandOpen(open => !open);
      }
      if (event.key === 'Escape') setCommandOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    localStorage.setItem('organic:sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem('organic:experience-mode', experienceMode);
  }, [experienceMode]);

  useEffect(() => {
    const openPanel = commandOpen ? commandRef.current : activityOpen ? activityRef.current : null;
    if (!openPanel) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const focusable = () => [...openPanel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(element => !element.hasAttribute('disabled'));
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setCommandOpen(false); setActivityOpen(false); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(); if (!items.length) return;
      const first = items[0]; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previousFocus.current?.focus(); };
  }, [commandOpen, activityOpen]);

  const shellClass = [
    'app-shell',
    collapsed ? 'sidebar-collapsed' : '',
    mobileOpen ? 'sidebar-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {user.impersonation && (
        <div className="impersonation-banner" role="status">
          <span>You are viewing the app as <strong>{user.name || user.email}</strong>. Actions use this user's permissions and are audited.</span>
          <button className="btn btn-secondary btn-sm" onClick={() => stopImpersonating()}>Return to {user.impersonation.actor.name || user.impersonation.actor.email}</button>
        </div>
      )}
      {/* ── Mobile overlay ── */}
      <button type="button" className="sidebar-overlay" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        {/* Desktop collapse toggle */}
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🔍</div>
          <div>
            <div className="sidebar-logo-text">Organic Command</div>
            <div className="sidebar-logo-sub">SEO + GEO operations</div>
          </div>
        </div>

        <WorkspaceSwitcher collapsed={collapsed} />

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <div className="nav-group">
            <span className="nav-group-label">Workspace</span>
            {PRIMARY_NAV.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={collapsed ? label : undefined} onClick={() => setMobileOpen(false)}>
                <Icon size={15} /><span className="nav-item-label">{label}</span>
              </NavLink>
            ))}
          </div>
          <details className="nav-tools" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}>
            <summary><Layers3 size={14}/><span>More tools</span><small>{modeLabel(experienceMode)}</small></summary>
            <div className="nav-group nav-tool-items">
              {visibleAdvanced.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={collapsed ? label : undefined} onClick={() => setMobileOpen(false)}>
                  <Icon size={15}/><span className="nav-item-label">{label}</span>
                </NavLink>
              ))}
            </div>
          </details>
          <div className="nav-group nav-config-group">
            <NavLink to={SETTINGS_NAV.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={collapsed ? SETTINGS_NAV.label : undefined} onClick={() => setMobileOpen(false)}>
              <Settings size={15}/><span className="nav-item-label">Settings</span>
            </NavLink>
          </div>
        </nav>

        <div className="sidebar-footer">
          {/* Signed-in user + logout */}
          <div className="user-chip">
            <div className="user-chip-avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</div>
            <div className="user-chip-meta">
              <div className="user-chip-name">{user.name || user.email}</div>
              <div className="user-chip-role">{user.is_super_admin ? 'Super-admin' : user.role}{user.totp_enabled ? ' · 2FA' : ''}</div>
            </div>
            <button className="btn-icon btn-icon-ghost" title="Sign out" aria-label="Sign out" onClick={() => logout()}>
              <LogOut size={14} />
            </button>
          </div>

          <label className="experience-mode-control">
            <span className="sidebar-footer-text">Workspace view</span>
            <select aria-label="Workspace feature view" value={experienceMode} onChange={event => { const next = event.target.value as ExperienceMode; setExperienceMode(next); if (next !== 'core') setToolsOpen(true); }}>
              <option value="core">Core</option>
              <option value="growth">Growth</option>
              <option value="agency">Agency</option>
            </select>
          </label>

          {/* Auth status */}
          <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: status?.auth.authenticated ? 'var(--ok)' : 'var(--warn)',
              boxShadow: status?.auth.authenticated ? '0 0 6px var(--ok)' : 'none',
            }} />
            <span className="sidebar-footer-text">
              {status?.auth.authenticated ? (
                <span className="text-dim truncate">Google Connected</span>
              ) : (
                <span className="text-warn">Not authenticated</span>
              )}
            </span>
          </div>

          {/* Scheduler / SSE status */}
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {status?.scheduler.running ? (
              <>
                <Activity size={11} style={{ color: 'var(--ok)', flexShrink: 0 }} />
                <span className="sidebar-footer-text" style={{ color: 'var(--ok)' }}>Run in progress</span>
              </>
            ) : (
              <>
                <Zap size={11} style={{ flexShrink: 0 }} />
                <span className="sidebar-footer-text">{status?.scheduler.cronSchedule ?? '—'}</span>
              </>
            )}
          </div>

          {needsSetup && (
            <div className="flex items-center gap-2 mt-2" style={{ fontSize: 12 }}>
              <AlertTriangle size={11} style={{ color: 'var(--warn)' }} />
              <NavLink to="/setup" className="sidebar-footer-text" style={{ color: 'var(--warn)', textDecoration: 'none', fontSize: 12 }}>
                Setup required
              </NavLink>
            </div>
          )}

          {/* SSE indicator */}
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: sseConnected ? 'var(--ok)' : 'var(--text-dim)',
            }} />
            <span className="sidebar-footer-text">{sseConnected ? 'Live stream connected' : 'Connecting…'}</span>
          </div>

          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="theme-toggle"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            <span className="sidebar-footer-text">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
        </div>
      </aside>

      {/* ── Mobile top bar ── */}
      <div className="mobile-header">
        <button
          className="hamburger"
          onClick={() => setMobileOpen(o => !o)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        >
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        <span className="mobile-header-title">Organic Command</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={toggleTheme}
            className="theme-toggle-mobile"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: status?.auth.authenticated ? 'var(--ok)' : 'var(--warn)',
            boxShadow: status?.auth.authenticated ? '0 0 6px var(--ok)' : 'none',
          }} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {status?.auth.authenticated ? 'Connected' : 'Not auth'}
          </span>
        </div>
      </div>

      {/* ── SSE disconnect banner ── */}
      {!sseConnected && (
        <div className="sse-banner" role="alert">
          <WifiOff size={14} />
          <span>Live stream disconnected — reconnecting…</span>
        </div>
      )}

      {/* ── Main ── */}
      <main className="main-content" id="main-content" tabIndex={-1}>
        <div className="global-toolbar">
          <div><span>{active?.name ?? 'Workspace'}</span><strong>{ALL_NAV.find(item => item.to === location.pathname || (item.to !== '/' && location.pathname.startsWith(`${item.to}/`)))?.label ?? 'Workspace detail'}</strong></div>
          <div className="global-toolbar-actions">
            <button type="button" className="activity-trigger" onClick={() => { setCommandOpen(false); setActivityOpen(true); }} aria-label="Open recent activity"><Activity size={14}/><span>Activity</span>{!sseConnected&&<i/>}</button>
            <button type="button" className="command-trigger" onClick={() => { setActivityOpen(false); setCommandOpen(true); }}><Search size={14} /><span>Jump to anything…</span><kbd><Command size={11} />K</kbd></button>
          </div>
        </div>
        <Outlet />
      </main>

      {commandOpen && (
        <div className="command-overlay" onMouseDown={() => setCommandOpen(false)}>
          <div ref={commandRef} className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-title" onMouseDown={event => event.stopPropagation()}>
            <h2 id="command-title" className="sr-only">Quick navigation</h2>
            <div className="command-search"><Search size={17} /><input value={commandQuery} onChange={event => setCommandQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && commandItems[0]) openCommandItem(commandItems[0].to); if (event.key === 'ArrowDown') { event.preventDefault(); commandRef.current?.querySelector<HTMLButtonElement>('.command-results button')?.focus(); } }} placeholder="Search pages and sites…" aria-label="Search pages and sites" aria-controls="command-results" /></div>
            <div className="command-results" id="command-results">
              {commandItems.map(item => <button key={`${item.to}:${item.label}`} onClick={() => openCommandItem(item.to)}><item.icon size={15} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={14} /></button>)}
              {!commandItems.length && <div className="command-no-results">No matching page or website</div>}
            </div>
            <div className="command-footer"><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span>Search your whole operating workspace</span></div>
          </div>
        </div>
      )}

      {activityOpen && (
        <div className="activity-overlay" onMouseDown={() => setActivityOpen(false)}>
          <aside ref={activityRef} className="activity-drawer" role="dialog" aria-modal="true" aria-labelledby="activity-title" onMouseDown={event => event.stopPropagation()}>
            <header><div><span>Live workspace</span><h2 id="activity-title">Recent activity</h2></div><button type="button" className="btn-icon btn-icon-ghost" aria-label="Close recent activity" onClick={() => setActivityOpen(false)}><X size={16}/></button></header>
            <div className="activity-connection"><i className={sseConnected ? 'connected' : ''}/><span>{sseConnected ? 'Live stream connected' : 'Reconnecting to live stream'}</span></div>
            <div className="activity-drawer-list">
              {logs.slice(0,30).map((entry, index) => <article key={`${entry.created_at ?? entry.run_id}:${index}`} className={`level-${entry.level}`}><time>{entry.created_at ? new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Now'}</time><span>{entry.message}</span></article>)}
              {!logs.length&&<div className="ops-empty compact"><Activity/><strong>No activity yet</strong><span>Runs, audits and submissions will appear here.</span></div>}
            </div>
            <footer><NavLink className="btn btn-secondary" to="/logs" onClick={() => setActivityOpen(false)}>Open full activity log <ArrowRight size={13}/></NavLink></footer>
          </aside>
        </div>
      )}

      {/* ── Toasts ── */}
      <ToastHost />
    </div>
  );
}
