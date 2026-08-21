import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import './index.css'
import './styles/streamlined.css'
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
const InsightsLayout = lazy(() => import('./pages/InsightsLayout'))
const SiteWorkspacePage = lazy(() => import('./pages/SiteWorkspace'))

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
          <Route path="/executive-view" element={<ClientPortalPage />} />
          <Route path="/portal" element={<Navigate to="/executive-view" replace />} />
          {/* All other pages use the sidebar layout */}
          <Route element={<Layout />}>
            <Route path="/"         element={<Dashboard />} />
            <Route path="/actions"  element={<ActionCenterPage />} />
            <Route path="/sites"    element={<SitesPage />} />
            <Route path="/sites/:siteId" element={<SiteWorkspacePage />} />
            <Route path="/publishing" element={<PublishingPage />} />
            {/* Google accounts now live under Settings → Google Accounts */}
            <Route path="/accounts" element={<Navigate to="/settings" replace />} />
            <Route path="/insights" element={<InsightsLayout />}>
              <Route index element={<Navigate to="search" replace />} />
              <Route path="search" element={<AnalyticsPage />} />
              <Route path="search/:siteId" element={<SiteAnalyticsPage />} />
              <Route path="ai" element={<CitationsPage />} />
              <Route path="evidence" element={<IntelligencePage />} />
              <Route path="entities" element={<EntitiesPage />} />
            </Route>
            <Route path="/analytics" element={<Navigate to="/insights/search" replace />} />
            <Route path="/analytics/:siteId" element={<LegacySiteInsightRedirect />} />
            <Route path="/intelligence" element={<Navigate to="/insights/evidence" replace />} />
            <Route path="/entities" element={<Navigate to="/insights/entities" replace />} />
            <Route path="/citations" element={<Navigate to="/insights/ai" replace />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/logs"     element={<LogsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/governance" element={<GovernancePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
  );
}

function LegacySiteInsightRedirect() {
  const { siteId } = useParams();
  return <Navigate to={`/insights/search/${siteId ?? ''}`} replace />;
}
