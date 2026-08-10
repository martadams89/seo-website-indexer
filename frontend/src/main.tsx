import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import { AppProvider } from './AppContext'
import { AuthGate } from './auth/AuthGate'
import { WorkspaceProvider } from './workspace/WorkspaceContext'
import Layout from './Layout'
import Dashboard from './pages/Dashboard'
import SitesPage from './pages/Sites'
import LogsPage from './pages/Logs'
import AnalyticsPage from './pages/Analytics'
import SiteAnalyticsPage from './pages/SiteAnalytics'
import CitationsPage from './pages/Citations'
import SettingsPage from './pages/Settings'
import SetupPage from './pages/Setup'
import ResetPasswordPage from './pages/ResetPassword'
import AcceptInvitePage from './pages/AcceptInvite'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
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
    </BrowserRouter>
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
          {/* All other pages use the sidebar layout */}
          <Route element={<Layout />}>
            <Route path="/"         element={<Dashboard />} />
            <Route path="/sites"    element={<SitesPage />} />
            {/* Google accounts now live under Settings → Google Accounts */}
            <Route path="/accounts" element={<Navigate to="/settings" replace />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/analytics/:siteId" element={<SiteAnalyticsPage />} />
            <Route path="/citations" element={<CitationsPage />} />
            <Route path="/logs"     element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
  );
}
