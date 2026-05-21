import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export interface Project {
  id: string
  name: string
  createdAt: number
}

const STORAGE_KEY_PROJECTS = 'freellmapi_projects'
const STORAGE_KEY_ACTIVE = 'freellmapi_active_project'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveProjects(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects))
}

export function getActiveProjectId(): string | null {
  return localStorage.getItem(STORAGE_KEY_ACTIVE)
}

export function setActiveProjectId(id: string | null) {
  if (id) {
    localStorage.setItem(STORAGE_KEY_ACTIVE, id)
  } else {
    localStorage.removeItem(STORAGE_KEY_ACTIVE)
  }
}

export function createProject(name?: string): Project {
  return {
    id: generateId(),
    name: name || `Chat ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    createdAt: Date.now(),
  }
}

export function renameProject(projectId: string, name: string) {
  const raw = localStorage.getItem(STORAGE_KEY_PROJECTS)
  if (!raw) return
  const projects: Project[] = JSON.parse(raw)
  const idx = projects.findIndex(p => p.id === projectId)
  if (idx === -1) return
  projects[idx].name = name
  saveProjects(projects)
  window.dispatchEvent(new CustomEvent('project-renamed', { detail: { projectId, name } }))
}

interface SidebarProps {
  activeProjectId: string | null
  onSelectProject: (id: string) => void
  onNewProject: () => void
}

export function Sidebar({ activeProjectId, onSelectProject, onNewProject }: SidebarProps) {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>(() => loadProjects())
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark'
    const stored = localStorage.getItem('theme')
    if (stored === 'dark' || stored === 'light') return stored as 'dark' | 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    const stored = localStorage.getItem('theme')
    if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [])

  useEffect(() => {
    function onRename() {
      setProjects(loadProjects())
    }
    window.addEventListener('project-renamed', onRename)
    return () => window.removeEventListener('project-renamed', onRename)
  }, [])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('theme', next)
  }

  function handleDelete(e: React.MouseEvent, projectId: string) {
    e.stopPropagation()
    const updated = projects.filter(p => p.id !== projectId)
    setProjects(updated)
    saveProjects(updated)
    localStorage.removeItem(`freellmapi_messages_${projectId}`)
    localStorage.removeItem(`freellmapi_project_model_${projectId}`)
    if (activeProjectId === projectId) {
      const first = updated[0]
      if (first) {
        onSelectProject(first.id)
      } else {
        onNewProject()
      }
    }
  }

  function handleNewProject() {
    const project = createProject()
    const updated = [project, ...projects]
    setProjects(updated)
    saveProjects(updated)
    onSelectProject(project.id)
    navigate('/playground')
  }

  return (
    <aside className="w-60 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col h-screen">
      <div className="p-3">
        <div className="text-xs font-semibold tracking-tight text-sidebar-foreground/80 mb-3 pl-1">
          FreeLLMAPI
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start text-xs"
          onClick={handleNewProject}
        >
          + New Chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {projects.length === 0 && (
          <p className="text-xs text-sidebar-foreground/40 pl-1 pt-2">
            No conversations yet
          </p>
        )}
        {projects.map(project => (
          <div
            key={project.id}
            className={`group flex items-center gap-1 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ${
              activeProjectId === project.id
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            }`}
            onClick={() => { onSelectProject(project.id); navigate('/playground') }}
          >
            <span
              className="flex-1 truncate text-[0.8125rem]"
              title={project.name}
              contentEditable={false}
            >
              {project.name}
            </span>
            <button
              className="opacity-0 group-hover:opacity-60 hover:opacity-100 text-xs px-1 transition-opacity"
              onClick={(e) => handleDelete(e, project.id)}
              aria-label="Delete project"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-sidebar-border p-2 space-y-1">
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
        >
          {theme === 'dark' ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2"/><path d="M12 20v2"/>
                <path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
                <path d="M2 12h2"/><path d="M20 12h2"/>
                <path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
              </svg>
              Light mode
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
              </svg>
              Dark mode
            </>
          )}
        </button>
        <NavLink
          to="/keys"
          className={({ isActive }) =>
            `flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
              isActive
                ? 'text-sidebar-foreground bg-sidebar-accent'
                : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
            }`
          }
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
          </svg>
          Keys
        </NavLink>
        <NavLink
          to="/analytics"
          className={({ isActive }) =>
            `flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
              isActive
                ? 'text-sidebar-foreground bg-sidebar-accent'
                : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
            }`
          }
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>
          </svg>
          Analytics
        </NavLink>
      </div>
    </aside>
  )
}
