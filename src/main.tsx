import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'

import { AuthProvider, useAuth } from './app/AuthProvider'
import AppShell from './components/layout/AppShell'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import InvestigationsPage from './pages/InvestigationsPage'
import NewInvestigationPage from './pages/NewInvestigationPage'
import InvestigationDetailPage from './pages/InvestigationDetailPage'
import ResearchPage from './pages/ResearchPage'
import EvidencePage from './pages/EvidencePage'
import AnalysisPage from './pages/AnalysisPage'
import ValidationPage from './pages/ValidationPage'
import HistoryPage from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'
import NotFoundPage from './pages/NotFoundPage'
import { FullPageLoading } from './components/layout/FullPageLoading'

/**
 * Route map.
 *
 * Public: `/` and `/login`. Everything under `/dashboard`, `/investigations`,
 * `/validation`, `/history` and `/settings` is wrapped by `<RequireAuth>`, so an
 * unauthenticated visitor is redirected to `/login` with the intended
 * destination preserved. The server enforces the same rule independently.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth()

  if (status === 'loading') return <FullPageLoading label="Verificando sessão" />

  if (status === 'anonymous') {
    const target = `${window.location.pathname}${window.location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(target)}`} replace />
  }

  return <>{children}</>
}

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/investigations" element={<InvestigationsPage />} />
          <Route path="/investigations/new" element={<NewInvestigationPage />} />
          <Route path="/investigations/:id" element={<InvestigationDetailPage />} />
          <Route path="/investigations/:id/research" element={<ResearchPage />} />
          <Route path="/investigations/:id/evidence" element={<EvidencePage />} />
          <Route path="/investigations/:id/analysis" element={<AnalysisPage />} />
          <Route path="/investigations/:id/validation" element={<ValidationPage />} />
          <Route path="/validation" element={<ValidationPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('Elemento #root não encontrado')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
