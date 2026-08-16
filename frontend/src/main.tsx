import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import { AppProvider } from './AppContext'
import { AuthGate } from './auth/AuthGate'
import { WorkspaceProvider } from './workspace/WorkspaceContext'
import Layout from './Layout'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const SitesPage = lazy(() => import('./pages/Sites'))
const LogsPage = lazy(() => import('./pages/Logs'))
const AnalyticsPage = lazy(() => import('./pages/Analytics'))
const SiteAnalyticsPage = lazy(() => import('./pages/SiteAnalytics'))
const CitationsPage = lazy(() => import('./pages/Citations'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const SetupPage = lazy(() => import('./pages/Setup'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPassword'))
const AcceptInvitePage = lazy(() => import('./pages/AcceptInvite'))
const ActionCenterPage = lazy(() => import('./pages/ActionCenter'))
const IntelligencePage = lazy(() => import('./pages/Intelligence'))
const IntegrationsPage = lazy(() => import('./pages/Integrations'))
const PublishingPage = lazy(() => import('./pages/Publishing'))
const ReportsPage = lazy(() => import('./pages/Reports'))
const GovernancePage = lazy(() => import('./pages/Governance'))
const EntitiesPage = lazy(() => import('./pages/Entities'))
const ClientPortalPage = lazy(() => import('./pages/ClientPortal'))

const loading = <div className="page-loading">Opening workspace…</div>

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><Suspense fallback={loading}>
      <Routes>
        {/* Public, outside the auth gate — reached from the emailed reset link */}
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* Public, outside the auth gate — reached from the emailed workspace-invite link */}
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/*" element={
          <AuthGate>
          <WorkspaceProvider>
          <AppProvider>
            <InnerRoutes />
          </AppProvider>
          </WorkspaceProvider>
          </AuthGate>
        } />
      </Routes>
    </Suspense></BrowserRouter>
  </StrictMode>
)

function InnerRoutes() {
  return (
        <Routes>
          {/* Setup has no sidebar */}
          <Route path="/setup" element={
            <div style={{ maxWidth: 700, margin: '40px auto', padding: '0 24px' }}>
              <SetupPage />
            </div>
          } />
          <Route path="/portal" element={<ClientPortalPage />} />
          {/* All other pages use the sidebar layout */}
          <Route element={<Layout />}>
            <Route path="/"         element={<Dashboard />} />
            <Route path="/actions"  element={<ActionCenterPage />} />
            <Route path="/sites"    element={<SitesPage />} />
            <Route path="/publishing" element={<PublishingPage />} />
            {/* Google accounts now live under Settings → Google Accounts */}
            <Route path="/accounts" element={<Navigate to="/settings" replace />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/analytics/:siteId" element={<SiteAnalyticsPage />} />
            <Route path="/intelligence" element={<IntelligencePage />} />
            <Route path="/entities" element={<EntitiesPage />} />
            <Route path="/citations" element={<CitationsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/logs"     element={<LogsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/governance" element={<GovernancePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
  );
}
