import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ScrollText, Settings, Zap, AlertTriangle, Activity,
} from 'lucide-react';
import { useApp } from './AppContext';
import { createLogStream } from './api';

// ── Sidebar Nav ───────────────────────────────────────────────────────────────

const NAV = [
  { to: '/',         icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sites',    icon: Globe,           label: 'Sites' },
  { to: '/logs',     icon: ScrollText,      label: 'Live Logs' },
  { to: '/settings', icon: Settings,        label: 'Settings' },
];

// ── Layout Component ──────────────────────────────────────────────────────────

export default function Layout() {
  const { status, appendLog } = useApp();
  const navigate = useNavigate();
  const [sseConnected, setSseConnected] = useState(false);

  const needsSetup = status && !status.auth.authenticated;

  // Redirect to onboarding if not configured
  useEffect(() => {
    if (status && !status.auth.authenticated && window.location.pathname !== '/setup') {
      navigate('/setup');
    }
  }, [status, navigate]);

  // SSE connection for live logs
  useEffect(() => {
    const disconnect = createLogStream(appendLog, () => setSseConnected(true));
    return disconnect;
  }, [appendLog]);

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🔍</div>
          <div>
            <div className="sidebar-logo-text">SEO Indexer</div>
            <div className="sidebar-logo-sub">Self-hosted</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          {/* Auth status */}
          <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: status?.auth.authenticated ? 'var(--ok)' : 'var(--warn)',
              boxShadow: status?.auth.authenticated ? '0 0 6px var(--ok)' : 'none',
            }} />
            {status?.auth.authenticated ? (
              <span className="text-dim truncate">Google Connected</span>
            ) : (
              <span className="text-warn">Not authenticated</span>
            )}
          </div>

          {/* Scheduler / SSE status */}
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {status?.scheduler.running ? (
              <>
                <Activity size={11} style={{ color: 'var(--ok)', flexShrink: 0 }} />
                <span style={{ color: 'var(--ok)' }}>Run in progress</span>
              </>
            ) : (
              <>
                <Zap size={11} style={{ flexShrink: 0 }} />
                <span>{status?.scheduler.cronSchedule ?? '—'}</span>
              </>
            )}
          </div>

          {needsSetup && (
            <div className="flex items-center gap-2 mt-2" style={{ fontSize: 11 }}>
              <AlertTriangle size={11} style={{ color: 'var(--warn)' }} />
              <NavLink to="/setup" style={{ color: 'var(--warn)', textDecoration: 'none', fontSize: 11 }}>
                Setup required
              </NavLink>
            </div>
          )}

          {/* SSE indicator */}
          <div className="flex items-center gap-2 mt-2" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: sseConnected ? 'var(--ok)' : 'var(--text-dim)',
            }} />
            {sseConnected ? 'Live stream connected' : 'Connecting…'}
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
