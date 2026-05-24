import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import { AppProvider } from './AppContext'
import Layout from './Layout'
import Dashboard from './pages/Dashboard'
import SitesPage from './pages/Sites'
import LogsPage from './pages/Logs'
import SettingsPage from './pages/Settings'
import SetupPage from './pages/Setup'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
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
            <Route path="/logs"     element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>
)
