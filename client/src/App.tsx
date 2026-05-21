import { useState, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar, createProject, setActiveProjectId, getActiveProjectId } from '@/components/Sidebar'
import { getAppBaseUrl } from '@/lib/base-url'
import PlaygroundPage from '@/pages/PlaygroundPage'
import KeysPage from '@/pages/KeysPage'
import AnalyticsPage from '@/pages/AnalyticsPage'

const queryClient = new QueryClient()

function App() {
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => getActiveProjectId())

  const handleSelectProject = useCallback((id: string) => {
    setActiveProjectId(id)
    setActiveProjectIdState(id)
  }, [])

  const handleNewProject = useCallback(() => {
    const project = createProject()

    const raw = localStorage.getItem('freellmapi_projects')
    const existing = raw ? JSON.parse(raw) : []
    localStorage.setItem('freellmapi_projects', JSON.stringify([project, ...existing]))

    setActiveProjectId(project.id)
    setActiveProjectIdState(project.id)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={getAppBaseUrl() || '/'}>
        <div className="flex h-screen bg-background">
          <Sidebar
            activeProjectId={activeProjectId}
            onSelectProject={handleSelectProject}
            onNewProject={handleNewProject}
          />
          <div className="flex-1 flex flex-col min-w-0">
            <Routes>
              <Route path="/" element={<Navigate to="/playground" replace />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/keys" element={<KeysPage />} />
              <Route path="/fallback" element={<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Fallback page</div>} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/test" element={<Navigate to="/playground" replace />} />
              <Route path="/health" element={<Navigate to="/keys" replace />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
