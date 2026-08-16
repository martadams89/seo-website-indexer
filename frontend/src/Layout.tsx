import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ScrollText, Settings, Zap, AlertTriangle, Activity,
  ChevronLeft, ChevronRight, Menu, X, Sun, Moon, WifiOff, LogOut,
  BarChart3, Bot, Search, Command, ArrowRight,
} from 'lucide-react';
import { useApp } from './AppContext';
import { useAuth } from './auth/AuthGate';
import { useWorkspace } from './workspace/WorkspaceContext';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
import { createLogStream } from './api';
import { ToastHost } from './components/Toast';

// ── Sidebar Nav ───────────────────────────────────────────────────────────────

const NAV_GROUPS = [
  { label: 'Operate', items: [
    { to: '/', icon: LayoutDashboard, label: 'Command Centre' },
    { to: '/sites', icon: Globe, label: 'Sites & Submissions' },
    { to: '/logs', icon: ScrollText, label: 'Live Activity' },
  ] },
  { label: 'Measure', items: [
    { to: '/analytics', icon: BarChart3, label: 'Search Analytics' },
    { to: '/citations', icon: Bot, label: 'AI Visibility' },
  ] },
  { label: 'Configure', items: [
    { to: '/settings', icon: Settings, label: 'Settings' },
  ] },
];
const NAV = NAV_GROUPS.flatMap(group => group.items);

// ── Layout Component ──────────────────────────────────────────────────────────

export default function Layout() {
  const { status, sites, appendLog, theme, toggleTheme, sseConnected, setSseConnected, markSseAlive } = useApp();
  const { user, logout, stopImpersonating } = useAuth();
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);   // desktop icon-only mode
  const [mobileOpen, setMobileOpen] = useState(false); // mobile drawer open
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');

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
  }, [appendLog, setSseConnected]);

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

  const shellClass = [
    'app-shell',
    collapsed ? 'sidebar-collapsed' : '',
    mobileOpen ? 'sidebar-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      {user.impersonation && (
        <div className="impersonation-banner" role="status">
          <span>You are viewing the app as <strong>{user.name || user.email}</strong>. Actions use this user's permissions and are audited.</span>
          <button className="btn btn-secondary btn-sm" onClick={() => stopImpersonating()}>Return to {user.impersonation.actor.name || user.impersonation.actor.email}</button>
        </div>
      )}
      {/* ── Mobile overlay ── */}
      <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />

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

        <nav className="sidebar-nav">
          {NAV_GROUPS.map(group => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={collapsed ? label : undefined} onClick={() => setMobileOpen(false)}>
                  <Icon size={15} /><span className="nav-item-label">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
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
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
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
            <div className="flex items-center gap-2 mt-2" style={{ fontSize: 11 }}>
              <AlertTriangle size={11} style={{ color: 'var(--warn)' }} />
              <NavLink to="/setup" className="sidebar-footer-text" style={{ color: 'var(--warn)', textDecoration: 'none', fontSize: 11 }}>
                Setup required
              </NavLink>
            </div>
          )}

          {/* SSE indicator */}
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
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
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
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
      <main className="main-content">
        <div className="global-toolbar">
          <div><span>{active?.name ?? 'Workspace'}</span><strong>{NAV.find(item => item.to === location.pathname)?.label ?? 'Workspace detail'}</strong></div>
          <button type="button" className="command-trigger" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Jump to anything…</span><kbd><Command size={11} />K</kbd></button>
        </div>
        <Outlet />
      </main>

      {commandOpen && (
        <div className="command-overlay" onMouseDown={() => setCommandOpen(false)}>
          <div className="command-palette" role="dialog" aria-modal="true" aria-label="Quick navigation" onMouseDown={event => event.stopPropagation()}>
            <div className="command-search"><Search size={17} /><input autoFocus value={commandQuery} onChange={event => setCommandQuery(event.target.value)} placeholder="Search pages and sites…" /></div>
            <div className="command-results">
              {[...NAV.map(item => ({ label: item.label, detail: 'Page', to: item.to, icon: item.icon })), ...sites.map(site => ({ label: site.name, detail: site.domain, to: '/sites', icon: Globe }))]
                .filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(commandQuery.toLowerCase()))
                .slice(0, 10).map(item => <button key={`${item.to}:${item.label}`} onClick={() => { navigate(item.to); setCommandOpen(false); setCommandQuery(''); }}><item.icon size={15} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={14} /></button>)}
            </div>
            <div className="command-footer"><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span>Search your whole operating workspace</span></div>
          </div>
        </div>
      )}

      {/* ── Toasts ── */}
      <ToastHost />
    </div>
  );
}
