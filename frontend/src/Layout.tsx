import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ScrollText, Settings, Zap, AlertTriangle, Activity,
  ChevronLeft, ChevronRight, Menu, X, Sun, Moon, WifiOff, LogOut
, BarChart3, Bot } from 'lucide-react';
import { useApp } from './AppContext';
import { useAuth } from './auth/AuthGate';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
import { createLogStream } from './api';
import { ToastHost } from './components/Toast';

// ── Sidebar Nav ───────────────────────────────────────────────────────────────

const NAV = [
  { to: '/',         icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sites',    icon: Globe,           label: 'Sites' },
  { to: '/analytics', icon: BarChart3,      label: 'Analytics' },
  { to: '/citations', icon: Bot,            label: 'AI Citations' },
  { to: '/logs',     icon: ScrollText,      label: 'Live Logs' },
  { to: '/settings', icon: Settings,        label: 'Settings' },
];

// ── Layout Component ──────────────────────────────────────────────────────────

export default function Layout() {
  const { status, appendLog, theme, toggleTheme, sseConnected, setSseConnected, markSseAlive } = useApp();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);   // desktop icon-only mode
  const [mobileOpen, setMobileOpen] = useState(false); // mobile drawer open

  const needsSetup = status && !status.auth.authenticated;

  // Redirect to onboarding if not configured
  useEffect(() => {
    if (status && !status.auth.authenticated && window.location.pathname !== '/setup') {
      navigate('/setup');
    }
  }, [status, navigate]);

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

  const shellClass = [
    'app-shell',
    collapsed ? 'sidebar-collapsed' : '',
    mobileOpen ? 'sidebar-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
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
            <div className="sidebar-logo-text">SEO Indexer</div>
            <div className="sidebar-logo-sub">Self-hosted</div>
          </div>
        </div>

        <WorkspaceSwitcher collapsed={collapsed} />

        <nav className="sidebar-nav">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              title={collapsed ? label : undefined}
              onClick={() => setMobileOpen(false)}
            >
              <Icon size={15} />
              <span className="nav-item-label">{label}</span>
            </NavLink>
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
        <span className="mobile-header-title">SEO Indexer</span>
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
        <Outlet />
      </main>

      {/* ── Toasts ── */}
      <ToastHost />
    </div>
  );
}
