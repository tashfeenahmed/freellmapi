import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import { 
  Search, 
  Paperclip, 
  ChevronDown, 
  Star, 
  Eye, 
  Brain, 
  FileText, 
  Image as ImageIcon, 
  Info, 
  ArrowUp,
  SlidersHorizontal,
  Plus,
  Trash2,
  Sparkles,
  MessageSquare
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

// Brand Logo component matching App header
function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block size-2 rounded-full bg-zinc-900 dark:bg-zinc-100" />
      <span className="font-semibold tracking-tight text-sm text-zinc-900 dark:text-zinc-100">FreeLLMAPI</span>
    </div>
  )
}

// Custom Brand SVG Logos with precise path rendering
function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M21.74 11.9a3.86 3.86 0 0 0-.1-1.64 4.02 4.02 0 0 0-1.42-2.14 4.2 4.2 0 0 0-2.45-.88c-.14-.02-.27-.06-.39-.12a4.11 4.11 0 0 0-3.3-3.66A4.3 4.3 0 0 0 11 4.14c-.11.08-.24.13-.38.16a4.12 4.12 0 0 0-3.65 3.32c-.02.13-.06.26-.12.38a4.2 4.2 0 0 0-3.5 3.51c-.02.14-.06.27-.12.39a4.12 4.12 0 0 0 3.3 3.66c.14.02.27.06.39.12a4.12 4.12 0 0 0 3.65 3.32A4.2 4.2 0 0 0 13 18.86c.11-.08.24-.13.38-.16a4.12 4.12 0 0 0 3.65-3.32c.02-.13.06-.26.12-.38a4.2 4.2 0 0 0 3.5-3.51c.02-.14.06-.27.12-.39h-.03zm-11 5.37a2.53 2.53 0 0 1-1.32-.4c.05-.03.11-.07.16-.1l3.52-2.03a.75.75 0 0 0 .37-.65v-4.9l1.45.84a.04.04 0 0 1 .02.03v4.06a2.54 2.54 0 0 1-4.2 2.15zm-2.82-3.18a2.53 2.53 0 0 1-.36-1.33c0-.06.01-.12.02-.18l.17.1 3.52 2.03c.23.13.51.13.74 0l4.24-2.45v1.68a.04.04 0 0 1-.02.03L12.1 16c-.95.55-2.13.5-3.03-.1l.01-.01zm-1.07-4.9a2.53 2.53 0 0 1 .95-1c.05.03.1.08.15.11l3.52 2.03a.75.75 0 0 0 .74 0l4.24-2.45v-1.68a.04.04 0 0 1 .02-.03l3.5 2.02c.94.55.99 1.73.08 2.33l-.01.01a2.53 2.53 0 0 1-1.32.4c-.05-.03-.1-.07-.15-.1l-3.52-2.03a.75.75 0 0 0-.74 0L8.43 11v-1.68l.01-.01zm4.72-2.73L9 5.62v-.03a2.54 2.54 0 0 1 4.2-2.15c.95.55 1 1.73.09 2.33l-.01.01a2.53 2.53 0 0 1-1.32.4c-.05-.03-.1-.07-.15-.1l-3.52-2.03a.75.75 0 0 0-.74 0l-4.24 2.45V4.86a.04.04 0 0 1 .02-.03l3.5-2.02a2.54 2.54 0 0 1 4.19 2.15v2.24zm4.24 2.45V13.8a.04.04 0 0 1-.02.03l-3.5 2.02c-.95.55-2.13.5-3.03-.1l.01-.01c.95-.55.99-1.73.08-2.33l-.01-.01a2.53 2.53 0 0 1 1.32-.4c.05.03.1.07.15.1l3.52 2.03a.75.75 0 0 0 .74 0l4.24-2.45V9.43a.04.04 0 0 1-.02-.03l3.5-2.02v.03a2.54 2.54 0 0 1-4.2 2.15v2.23zm1.18 5.61a2.53 2.53 0 0 1-2.27.18l-.17-.1v-4.06c0-.26-.14-.5-.37-.63l-4.24-2.45v-1.68c0-.02.01-.03.02-.03l3.5-2.02c.95-.55 2.13-.5 3.03.1l-.01.01c-.95.55-.99 1.73-.08 2.33l.01.01a2.53 2.53 0 0 1 1.32-.4c.05.03.1.07.15.1l3.52 2.03a.75.75 0 0 0 .37.63v4.06a2.54 2.54 0 0 1-2.28 2.15z"/>
    </svg>
  );
}

function AnthropicLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M16.92 3.65a1.2 1.2 0 0 0-1.12-.77H8.2a1.2 1.2 0 0 0-1.12.77L2.24 19.33a1.2 1.2 0 0 0 1.12 1.55h3.63a1.2 1.2 0 0 0 1.12-.77l1.45-4.52h4.88l1.45 4.52a1.2 1.2 0 0 0 1.12.77h3.63a1.2 1.2 0 0 0 1.12-1.55L16.92 3.65zm-2.85 10H9.93l2.03-6.35 2.03 6.35z"/>
    </svg>
  );
}

function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2a1 1 0 0 0-1 1v1.17C11 8.2 8.2 11 4.17 11H3a1 1 0 0 0 0 2h1.17C8.2 13 11 15.8 11 19.83V21a1 1 0 0 0 2 0v-1.17c0-4.03 2.8-6.83 6.83-6.83H21a1 1 0 0 0 0-2h-1.17c-4.03 0-6.83-2.8-6.83-6.83V3a1 1 0 0 0-1-1zm6 3a.5.5 0 0 0-.5.5v.33c0 1-.8 1.83-1.83 1.83h-.33a.5.5 0 0 0 0 1h.33c1 0 1.83.8 1.83 1.83v.33a.5.5 0 0 0 1 0v-.33c0-1 .8-1.83 1.83-1.83h.33a.5.5 0 0 0 0-1h-.33c-1 0-1.83-.8-1.83-1.83v-.33A.5.5 0 0 0 18 5z"/>
    </svg>
  );
}

function MetaLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M19.9 8.25c-1.1 0-2.1.4-2.85 1.15a6.5 6.5 0 0 0-10.1 0c-.75-.75-1.75-1.15-2.85-1.15C1.8 8.25.05 10 .05 12.15S1.8 16.05 4.1 16.05c1.1 0 2.1-.4 2.85-1.15a6.5 6.5 0 0 0 10.1 0c.75.75 1.75 1.15 2.85 1.15 2.3 0 4.05-1.75 4.05-3.9s-1.75-3.9-4.05-3.9zm-15.8 6.3c-1.3 0-2.35-1.05-2.35-2.4s1.05-2.4 2.35-2.4c.8 0 1.5.4 1.95 1.05-.7.8-1.25 1.75-1.6 2.8-.2-.05-.25-.05-.35-.05zm7.9-1.2a4.48 4.48 0 0 1-1.3-2.95c.5-.4 1.1-.65 1.8-.75.7.1 1.3.35 1.8.75a4.48 4.48 0 0 1-1.3 2.95c-.25.25-.65.45-1 .45s-.75-.2-1-.45zm3.95 1.25c-.35-1.05-.9-2-1.6-2.8.45-.65 1.15-1.05 1.95-1.05 1.3 0 2.35 1.05 2.35 2.4s-1.05 2.4-2.35 2.4c-.1 0-.15 0-.35-.05z"/>
    </svg>
  );
}

function MistralLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2L2 9.5v8L12 22l10-4.5v-8L12 2zm8 14.5l-8 3.6-8-3.6V10.9l8 3.6 8-3.6v5.6zM12 5.4l6.5 2.9-6.5 2.9L5.5 8.3 12 5.4z"/>
    </svg>
  );
}

function CohereLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 13v1c0 1.1.9 2 2 2h2v3.93zm5.28-2.61c-.13-.39-.46-.7-.87-.82L15 17v-2c0-.55-.45-1-1-1h-4v-2h2c.55 0 1-.45 1-1V9h2c1.1 0 2-.9 2-2V5.59c1.72 1.39 2.87 3.51 2.98 5.91l-1.7 1.82c-.39.42-.39 1.07 0 1.49l1.7 1.82c.16.17.26.39.3.61z"/>
    </svg>
  );
}

function SidebarToggleIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: {
    name: string
    size: number
    type: string
    previewUrl?: string
  }[]
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
  }
}

interface Conversation {
  id: number
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

interface EnrichedModel {
  id: string
  displayName: string
  platform: string
  provider: 'openai' | 'anthropic' | 'google' | 'meta' | 'mistral' | 'cohere'
  priceTier: '$' | '$$' | '$$$' | '$$$+'
  description: string
  capabilities: {
    vision?: boolean
    reasoning?: boolean
    context?: boolean
    image?: boolean
  }
  isFavorite: boolean
}

// Enrich database models dynamically
function enrichModel(m: FallbackEntry, isFavorite = false): EnrichedModel {
  const modelIdLower = m.modelId.toLowerCase()
  
  let provider: EnrichedModel['provider'] = 'cohere'
  let platform = m.platform
  
  if (modelIdLower.includes('gpt') || modelIdLower.includes('openai')) {
    provider = 'openai'
    platform = 'OpenAI'
  } else if (modelIdLower.includes('claude') || modelIdLower.includes('anthropic')) {
    provider = 'anthropic'
    platform = 'Anthropic'
  } else if (modelIdLower.includes('gemini') || modelIdLower.includes('google')) {
    provider = 'google'
    platform = 'Google'
  } else if (modelIdLower.includes('llama') || modelIdLower.includes('meta')) {
    provider = 'meta'
    platform = 'Meta'
  } else if (modelIdLower.includes('mistral') || modelIdLower.includes('mixtral') || modelIdLower.includes('codestral')) {
    provider = 'mistral'
    platform = 'Mistral'
  }

  let priceTier: EnrichedModel['priceTier'] = '$$'
  if (modelIdLower.includes('mini') || modelIdLower.includes('flash') || modelIdLower.includes('haiku') || modelIdLower.includes('8b') || modelIdLower.includes('nano')) {
    priceTier = '$'
  } else if (modelIdLower.includes('opus') || modelIdLower.includes('ultra') || modelIdLower.includes('5.5') || modelIdLower.includes('400b')) {
    priceTier = '$$$+'
  } else if (modelIdLower.includes('pro') || modelIdLower.includes('large') || modelIdLower.includes('sonnet') || modelIdLower.includes('70b') || modelIdLower.includes('5.4')) {
    priceTier = '$$$'
  }

  const hasVision = modelIdLower.includes('vision') || modelIdLower.includes('gpt-4') || modelIdLower.includes('claude') || modelIdLower.includes('gemini') || modelIdLower.includes('5.')
  const hasReasoning = !modelIdLower.includes('image')
  const hasContext = modelIdLower.includes('pro') || modelIdLower.includes('sonnet') || modelIdLower.includes('opus') || modelIdLower.includes('large') || modelIdLower.includes('gpt-4') || modelIdLower.includes('gpt-5') || modelIdLower.includes('gemini')
  const hasImage = modelIdLower.includes('image') || modelIdLower.includes('dall-e')

  return {
    id: m.modelId,
    displayName: m.displayName,
    platform,
    provider,
    priceTier,
    description: `High performance ${m.displayName} powered by ${m.platform}.`,
    capabilities: {
      vision: hasVision,
      reasoning: hasReasoning,
      context: hasContext,
      image: hasImage,
    },
    isFavorite,
  }
}

// Re-designed highly aesthetic premium Sidebar Component with full dark mode support
function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onToggle,
}: {
  conversations: Conversation[]
  activeId: number | null
  onSelect: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
  onToggle: () => void
}) {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredConversations = conversations.filter(c => 
    (c.title || 'New Chat').toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="w-full shrink-0 flex flex-col h-full overflow-hidden select-none">
      
      {/* Header Panel with Brand logo & Sidebar close toggle */}
      <div className="flex items-center justify-between px-4 pt-4.5 pb-2">
        <Brand />
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
          title="Hide sidebar"
        >
          <SidebarToggleIcon className="size-3.5" />
        </button>
      </div>

      {/* New Chat Solid Premium Button */}
      <div className="px-3 pb-2 pt-1">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-1.5 py-2 px-4 bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 text-white dark:text-zinc-950 rounded-xl text-xs font-semibold transition-all shadow-[0_2px_4px_rgba(0,0,0,0.06)] active:scale-[0.98] cursor-pointer"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />
          New Chat
        </button>
      </div>

      {/* Chat Search Input Bar */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-400 dark:text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            className="w-full pl-8.5 pr-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/50 dark:border-zinc-800 rounded-xl text-[11px] focus:outline-none focus:border-zinc-300 dark:focus:border-zinc-700 focus:bg-white dark:focus:bg-zinc-900 transition-all text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
          />
        </div>
      </div>

      {/* Scrollable List Area */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {conversations.length === 0 ? (
          <div className="text-center py-8 px-4">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">No chats yet.</p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="text-center py-8 px-4">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">No matching chats.</p>
          </div>
        ) : (
          filteredConversations.map(c => {
            const isActive = c.id === activeId
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs transition-all cursor-pointer ${
                  isActive
                    ? 'font-bold text-zinc-900 dark:text-white bg-zinc-200/50 dark:bg-zinc-800/60 shadow-[0_1px_2px_rgba(0,0,0,0.01)]'
                    : 'font-semibold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/30 hover:text-zinc-850 dark:hover:text-zinc-200'
                }`}
              >
                <MessageSquare className={`size-4 shrink-0 transition-colors ${isActive ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-300 dark:text-zinc-500 group-hover:text-zinc-500'}`} />
                <span className="truncate flex-1 pr-6">{c.title || 'New Chat'}</span>
                
                {/* Delete action with shadcn Alert Dialog confirmation */}
                <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 flex items-center justify-center">
                  <AlertDialog>
                    <AlertDialogTrigger>
                      <button
                        type="button"
                        className="p-1 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/40 transition-all duration-150 cursor-pointer flex items-center justify-center"
                        onClick={e => e.stopPropagation()}
                        aria-label="Delete chat"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent onClick={e => e.stopPropagation()} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl max-w-sm sm:max-w-md shadow-xl select-none p-5 text-zinc-900 dark:text-zinc-100">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-zinc-900 dark:text-zinc-100 text-sm font-bold">Delete Conversation?</AlertDialogTitle>
                        <AlertDialogDescription className="text-zinc-500 dark:text-zinc-400 text-[11px] leading-relaxed mt-1">
                          Are you sure you want to permanently delete this chat history? This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter className="mt-4 flex gap-2 justify-end">
                        <AlertDialogCancel className="bg-zinc-100 hover:bg-zinc-200/80 text-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 border border-transparent rounded-xl text-[11px] py-1.5 px-3.5 cursor-pointer font-semibold transition-colors">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onDelete(c.id)}
                          className="bg-rose-600 hover:bg-rose-700 dark:bg-rose-50 dark:hover:bg-rose-600 text-white border border-transparent rounded-xl text-[11px] py-1.5 px-3.5 cursor-pointer font-semibold transition-colors shadow-sm"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default function PlaygroundPage({ 
  sidebarOpen, 
  setSidebarOpen 
}: { 
  sidebarOpen: boolean
  setSidebarOpen: (o: boolean) => void 
}) {
  const queryClient = useQueryClient()
  const { chatId } = useParams<{ chatId?: string }>()
  const navigate = useNavigate()
  const activeId = chatId ? parseInt(chatId, 10) : null
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  
  // Custom design-related states
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('favorites')
  const [favorites, setFavorites] = useState<string[]>(() => {
    const stored = localStorage.getItem('model-favorites')
    return stored ? JSON.parse(stored) : []
  })

  const [attachedFile, setAttachedFile] = useState<{
    name: string
    size: number
    type: string
    previewUrl?: string
  } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ['conversations'],
    queryFn: () => apiFetch('/api/conversations'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  // Sync favorites persistence
  useEffect(() => {
    localStorage.setItem('model-favorites', JSON.stringify(favorites))
  }, [favorites])

  // Handle click outside to close model selector popover
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsModelSelectorOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Responsive: Listen to resize to close sidebar automatically on small screens
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth < 768 && sidebarOpen) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [sidebarOpen, setSidebarOpen])

  // Create unified models catalog (using real models only)
  const allModels = useRef<EnrichedModel[]>([])
  
  const buildModelsList = useCallback(() => {
    const temp: EnrichedModel[] = []
    
    // Add real database entries only
    availableModels.forEach((m: FallbackEntry) => {
      const isFav = favorites.includes(m.modelId)
      temp.push(enrichModel(m, isFav))
    })
    
    allModels.current = temp
    
    // Auto-update selected provider if there are models available
    if (temp.length > 0 && selectedProvider !== 'favorites' && !temp.some(m => m.provider === selectedProvider)) {
      const firstAvailable = temp.find(m => m.provider)?.provider
      if (firstAvailable) {
        setSelectedProvider(firstAvailable)
      }
    }
  }, [availableModels, favorites, selectedProvider])

  buildModelsList()

  const createMutation = useMutation({
    mutationFn: () => apiFetch<Conversation>('/api/conversations', { method: 'POST', body: '{}' }),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      navigate(`/playground/${conv.id}`)
      setMessages([])
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, title, messages }: { id: number; title?: string; messages: ChatMessage[] }) =>
      apiFetch<Conversation>(`/api/conversations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title, messages }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  useEffect(() => {
    if (activeId) {
      apiFetch<Conversation>(`/api/conversations/${activeId}`)
        .then(conv => setMessages(conv.messages))
        .catch(() => navigate('/playground'))
    } else {
      setMessages([])
    }
  }, [activeId])

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText || input).trim()
    if (!text || loading) return

    let convId = activeId
    if (!convId) {
      const conv = await createMutation.mutateAsync()
      convId = conv.id
    }

    const userMsg: ChatMessage = { 
      role: 'user', 
      content: text,
      attachments: attachedFile ? [attachedFile] : undefined
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setAttachedFile(null)
    setLoading(true)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: newMessages.map(m => {
          const hasImages = m.attachments && m.attachments.some(a => a.type.startsWith('image/'))
          if (hasImages && m.attachments) {
            const parts: any[] = [{ type: 'text', text: m.content }]
            m.attachments.forEach(att => {
              if (att.type.startsWith('image/') && att.previewUrl) {
                parts.push({
                  type: 'image_url',
                  image_url: {
                    url: att.previewUrl
                  }
                })
              }
            })
            return { role: m.role, content: parts }
          }
          return { role: m.role, content: m.content }
        }),
        stream: true
      }
      
      if (selectedModel !== 'auto') {
        body.model = selectedModel
      }

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        const withError = [...newMessages, { role: 'assistant' as const, content: `Error: ${err.error?.message ?? 'Unknown error'}` }]
        setMessages(withError)
        updateMutation.mutate({ id: convId, messages: withError })
        return
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response reader available')

      const decoder = new TextDecoder()
      let buffer = ''
      let accumulatedContent = ''
      const via = routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined

      // Append an empty assistant message that will be populated as chunks stream in
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      }
      let currentMessages = [...newMessages, assistantMsg]
      setMessages(currentMessages)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const raw = trimmed.slice(6)
          if (raw === '[DONE]') break

          try {
            const parsed = JSON.parse(raw)
            const text = parsed.choices?.[0]?.delta?.content ?? ''
            if (text) {
              accumulatedContent += text
              currentMessages = currentMessages.map((m, idx) => {
                if (idx === currentMessages.length - 1) {
                  return {
                    ...m,
                    content: accumulatedContent,
                  }
                }
                return m
              })
              setMessages(currentMessages)
            }
          } catch {
            // Ignore parse errors on individual frames
          }
        }
      }

      const isFirstMessage = messages.length === 0
      updateMutation.mutate({
        id: convId,
        title: isFirstMessage ? text.slice(0, 60) : undefined,
        messages: currentMessages,
      })
    } catch (err: any) {
      const withError = [...newMessages, { role: 'assistant' as const, content: `Error: ${err.message}` }]
      setMessages(withError)
      updateMutation.mutate({ id: convId, messages: withError })
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSelectConversation(id: number) {
    if (activeId === id) return
    if (messages.length > 0 && activeId) {
      updateMutation.mutate({ id: activeId, messages })
    }
    navigate(`/playground/${id}`)
  }

  function handleNewChat() {
    if (messages.length > 0 && activeId) {
      updateMutation.mutate({ id: activeId, messages })
    }
    createMutation.mutate()
  }

  function handleDeleteConversation(id: number) {
    apiFetch(`/api/conversations/${id}`, { method: 'DELETE' }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (activeId === id) {
        navigate('/playground')
        setMessages([])
      }
      toast.success('Conversation deleted')
    })
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const fileData = {
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: undefined as string | undefined
      }

      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onloadend = () => {
          setAttachedFile({
            ...fileData,
            previewUrl: reader.result as string
          })
        }
        reader.readAsDataURL(file)
      } else {
        setAttachedFile(fileData)
      }
    }
  }

  const toggleFavorite = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const isCurrentlyFav = favorites.includes(modelId)
    setFavorites(prev => 
      isCurrentlyFav
        ? prev.filter(id => id !== modelId)
        : [...prev, modelId]
    )
    toast.success(isCurrentlyFav ? 'Removed from favorites' : 'Added to favorites')
  }

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId)
    setIsModelSelectorOpen(false)
    const name = modelId === 'auto' ? 'Auto Router' : allModels.current.find(m => m.id === modelId)?.displayName || modelId
    toast.success(`Model active: ${name}`)
  }

  // Find active model details
  const activeModelObj = allModels.current.find(m => m.id === selectedModel)
  const activeModelDisplay = selectedModel === 'auto'
    ? {
        id: 'auto',
        displayName: 'Auto Router',
        platform: 'System',
        priceTier: '$$' as const,
        provider: 'favorites' as const,
      }
    : activeModelObj || {
        id: selectedModel,
        displayName: selectedModel,
        platform: 'External',
        priceTier: '$$' as const,
        provider: 'cohere' as const,
      }

  function getProviderIcon(provider: string, className = "size-4") {
    switch (provider) {
      case 'openai':
        return <OpenAILogo className={`${className} text-[#10a37f]`} />
      case 'anthropic':
        return <AnthropicLogo className={`${className} text-[#d97706]`} />
      case 'google':
        return <GeminiLogo className={`${className} text-[#2563eb]`} />
      case 'meta':
        return <MetaLogo className={`${className} text-[#0284c7]`} />
      case 'mistral':
        return <MistralLogo className={`${className} text-[#ea580c]`} />
      case 'favorites':
        return <Sparkles className={`${className} text-indigo-500 fill-indigo-100 dark:fill-indigo-950/20`} />
      default:
        return <CohereLogo className={`${className} text-teal-600`} />
    }
  }

  // Filter models for selector popover
  const filteredModels = allModels.current.filter(model => {
    const matchesSearch = 
      model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.platform.toLowerCase().includes(searchQuery.toLowerCase())

    if (!matchesSearch) return false

    if (selectedProvider === 'favorites') {
      return model.isFavorite
    }
    return model.provider === selectedProvider
  })

  const showEmptyState = messages.length === 0 && !loading

  return (
    <div className="flex-1 flex h-[calc(100dvh-49px)] bg-white dark:bg-zinc-950 relative overflow-hidden text-zinc-950 dark:text-zinc-50 font-sans">
      
      {/* Mobile Drawer Backdrop overlay with smooth transition */}
      {sidebarOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-black/35 backdrop-blur-xs z-40 transition-opacity animate-in fade-in duration-200"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Full-Height Fixed Sidebar with sliding CSS animations */}
      <div 
        className={`fixed inset-y-0 left-0 z-50 h-screen bg-[#fbfbfb] dark:bg-zinc-900 border-r border-zinc-200/60 dark:border-zinc-800/80 flex flex-col transition-all duration-300 ease-in-out ${
          sidebarOpen 
            ? 'w-64 translate-x-0' 
            : 'w-0 -translate-x-full'
        }`}
      >
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            handleSelectConversation(id)
            if (window.innerWidth < 768) setSidebarOpen(false)
          }}
          onNew={() => {
            handleNewChat()
            if (window.innerWidth < 768) setSidebarOpen(false)
          }}
          onDelete={handleDeleteConversation}
          onToggle={() => setSidebarOpen(false)}
        />
      </div>

      {/* Main Workspace Column with responsive width margin transitions */}
      <div className={`flex-1 flex flex-col min-w-0 bg-white dark:bg-zinc-950 transition-all duration-300 relative ${
        sidebarOpen ? 'md:ml-64' : ''
      }`}>
        
        {/* Dynamic Workspace Header Top Bar */}
        <div className="flex items-center justify-between h-13 px-5 border-b border-zinc-100 dark:border-zinc-900 shrink-0 select-none bg-transparent">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Show sidebar"
              >
                <SidebarToggleIcon className="size-3.5" />
              </button>
            )}
            <span className="text-[12px] font-bold text-zinc-800 dark:text-zinc-200">
              {activeId 
                ? (conversations.find(c => c.id === activeId)?.title || 'Active Chat') 
                : 'Playground'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-semibold px-2 py-0.5 rounded-md tracking-wider uppercase">
              {activeModelDisplay.displayName}
            </span>
          </div>
        </div>

        {showEmptyState ? (
          <div className="flex-1 flex items-center justify-center px-4 sm:px-6 relative z-10">
            <div className="w-full max-w-2xl mx-auto">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-850 dark:text-zinc-100 mb-8 px-2 text-center">How can I help you?</h1>
              
              <div className="flex flex-wrap gap-2.5 mb-8 px-2">
                <button className="flex items-center gap-2 px-3.5 py-1.5 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 rounded-full text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shadow-sm">
                  <Sparkles className="size-3.5" /> Create
                </button>
                <button className="flex items-center gap-2 px-3.5 py-1.5 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 rounded-full text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shadow-sm">
                  <FileText className="size-3.5" /> Explore
                </button>
                <button className="flex items-center gap-2 px-3.5 py-1.5 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 rounded-full text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shadow-sm">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg> Code
                </button>
                <button className="flex items-center gap-2 px-3.5 py-1.5 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 rounded-full text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shadow-sm">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg> Learn
                </button>
              </div>

              <div className="flex flex-col border-t border-zinc-100 dark:border-zinc-800/60 mt-4">
                {[
                  "How does AI work?",
                  "Are black holes real?",
                  "How many Rs are in the word \"strawberry\"?",
                  "What is the meaning of life?"
                ].map((suggestion, idx) => (
                  <button 
                    key={idx}
                    onClick={() => {
                      setInput(suggestion);
                      handleSend(suggestion);
                    }}
                    className="text-left py-4 px-4 border-b border-zinc-100 dark:border-zinc-800/60 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors text-[15px] font-medium cursor-pointer"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 pt-8 pb-36 bg-[#fafafa]/30 dark:bg-zinc-950/20">
            <div className="max-w-4xl mx-auto space-y-6">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-4.5 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200/40 dark:border-zinc-700/40 shadow-xs font-semibold'
                        : 'bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800/80 shadow-[0_1px_2px_rgba(0,0,0,0.02)] text-zinc-850 dark:text-zinc-200'
                    }`}
                  >
                    {/* Render Attachments if present */}
                    {msg.attachments && msg.attachments.map((file, idx) => (
                      <div key={idx} className="mb-2 max-w-xs sm:max-w-sm rounded-xl overflow-hidden border border-zinc-200/60 dark:border-zinc-800 shadow-[0_1px_3px_rgba(0,0,0,0.03)] select-none">
                        {file.previewUrl ? (
                          <img 
                            src={file.previewUrl} 
                            alt={file.name} 
                            className="max-h-48 w-full object-cover" 
                          />
                        ) : (
                          <div className="flex items-center gap-2 p-2.5 bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-700 dark:text-zinc-300">
                            <FileText className="size-4 text-zinc-400 dark:text-zinc-500" />
                            <span className="font-semibold truncate">{file.name}</span>
                          </div>
                        )}
                      </div>
                    ))}

                    <MarkdownRenderer content={msg.content} />
                    {msg.meta && (
                      <div className="flex items-center gap-2 mt-2 flex-wrap text-[10px] opacity-60 dark:opacity-50 tabular-nums">
                        {msg.meta.platform && <span>{msg.meta.platform}</span>}
                        {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                        {msg.meta.latency != null && <span>· {msg.meta.latency}ms</span>}
                        {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                          <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800/80 rounded-2xl px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                    <div className="flex gap-1.5">
                      <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Premium Light-Themed Chat Card Layout */}
        <div className={`fixed bottom-0 right-0 bg-gradient-to-t from-white via-white dark:from-zinc-950 dark:via-zinc-950 to-transparent p-4 sm:p-6 pt-10 z-20 transition-all duration-300 ${
          sidebarOpen ? 'left-0 md:left-64' : 'left-0'
        }`}>
          <div className="max-w-4xl mx-auto">
            
            {/* Outer Container Card */}
            <div className="border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.03)] focus-within:border-zinc-300 dark:focus-within:border-zinc-700 focus-within:shadow-[0_4px_16px_rgba(0,0,0,0.05)] transition-all duration-200 p-3 sm:p-3.5 space-y-3 relative">
              
              {/* Text Input Block */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message here..."
                rows={1}
                className="w-full resize-none bg-transparent px-1.5 py-1 text-sm focus:outline-none text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 min-h-[40px] max-h-[180px] leading-relaxed"
                style={{ height: 'auto', overflow: 'hidden' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
                }}
              />

              {/* Attachment Preview Card */}
              {attachedFile && (
                <div className="flex items-center gap-2.5 p-2 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/50 dark:border-zinc-800/60 rounded-xl w-fit relative group animate-in fade-in zoom-in-95 duration-200 select-none ml-1.5 mt-1.5">
                  {attachedFile.previewUrl ? (
                    <img 
                      src={attachedFile.previewUrl} 
                      alt="preview" 
                      className="size-11 object-cover rounded-lg border border-zinc-200/60 dark:border-zinc-800/60" 
                    />
                  ) : (
                    <div className="size-11 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/30 dark:border-zinc-700/30 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                      <FileText className="size-5" />
                    </div>
                  )}
                  <div className="flex flex-col text-[11px] pr-2 max-w-[180px]">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300 truncate">{attachedFile.name}</span>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal">{(attachedFile.size / 1024).toFixed(1)} KB</span>
                  </div>
                  
                  {/* Remove Attachment Button */}
                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="absolute -top-1.5 -right-1.5 size-4.5 bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-zinc-900 rounded-full flex items-center justify-center cursor-pointer transition-transform hover:scale-105 shadow-[0_1px_3px_rgba(0,0,0,0.1)] text-[9px] font-bold border border-zinc-200/10 dark:border-zinc-800/10"
                    title="Remove file"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Hidden file input */}
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
              />

              {/* Footer Row Controls */}
              <div className="flex items-center justify-between border-t border-zinc-50 dark:border-zinc-800/60 pt-2.5">
                
                <div className="flex items-center gap-2">
                  
                  {/* Anchor / Trigger containing the model badge dropdown */}
                  <div className="relative" ref={popoverRef}>
                    <button
                      type="button"
                      onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200/85 dark:active:bg-zinc-700/85 border border-zinc-200/50 dark:border-zinc-700/30 rounded-full text-xs font-semibold text-zinc-700 dark:text-zinc-300 transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
                    >
                      {getProviderIcon(activeModelDisplay.provider, "size-3.5")}
                      <span className="truncate max-w-[80px] sm:max-w-none">{activeModelDisplay.displayName}</span>
                      <span className="text-emerald-600 dark:text-emerald-500 font-bold text-[10px]">{activeModelDisplay.priceTier}</span>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <ChevronDown className="size-3 text-zinc-400" />
                    </button>

                    {/* Highly Interactive Floating Model Selector Popover */}
                    {isModelSelectorOpen && (
                      <div className="absolute bottom-full left-0 mb-3.5 w-[calc(100vw-32px)] sm:w-[420px] max-w-[420px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl z-50 flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150">
                        
                        {/* Search Input Bar with filter symbol */}
                        <div className="p-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2 bg-white dark:bg-zinc-900">
                          <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-400" />
                            <input
                              type="text"
                              value={searchQuery}
                              onChange={e => setSearchQuery(e.target.value)}
                              placeholder="Search models..."
                              className="w-full pl-8.5 pr-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-800 rounded-lg text-xs focus:outline-none focus:border-zinc-300 dark:focus:border-zinc-700 focus:bg-white dark:focus:bg-zinc-900 transition-all text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500"
                            />
                          </div>
                          <button 
                            type="button" 
                            className="size-7 flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                            title="Filter configurations"
                          >
                            <SlidersHorizontal className="size-3.5" />
                          </button>
                        </div>

                        {/* Split Body Container */}
                        <div className="flex h-[320px] bg-white dark:bg-zinc-900">
                          
                          {/* Sidebar Vertical Icons Panel */}
                          <div className="w-13.5 bg-zinc-50/50 dark:bg-zinc-950/20 border-r border-zinc-100 dark:border-zinc-800/60 flex flex-col items-center py-3 gap-3 select-none">
                            {[
                              { id: 'favorites', label: 'Favorites', icon: <Star className="size-4" /> },
                              { id: 'openai', label: 'OpenAI', icon: <OpenAILogo className="size-4" /> },
                              { id: 'anthropic', label: 'Anthropic Claude', icon: <AnthropicLogo className="size-4" /> },
                              { id: 'google', label: 'Google Gemini', icon: <GeminiLogo className="size-4" /> },
                              { id: 'meta', label: 'Meta Llama', icon: <MetaLogo className="size-4" /> },
                              { id: 'mistral', label: 'Mistral AI', icon: <MistralLogo className="size-4" /> },
                              { id: 'cohere', label: 'Other/Cohere', icon: <CohereLogo className="size-4" /> }
                            ].map(tab => {
                              const hasConfiguredModels = allModels.current.some(m => m.provider === tab.id)
                              if (tab.id !== 'favorites' && !hasConfiguredModels) return null

                              return (
                                <button
                                  key={tab.id}
                                  type="button"
                                  onClick={() => setSelectedProvider(tab.id)}
                                  className={`size-8.5 flex items-center justify-center rounded-lg transition-all cursor-pointer ${
                                    selectedProvider === tab.id
                                      ? 'bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/80 text-zinc-900 dark:text-white shadow-sm'
                                      : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40'
                                  }`}
                                  title={tab.label}
                                >
                                  {tab.icon}
                                </button>
                              )
                            })}
                          </div>

                          {/* Right Model Cards List */}
                          <div className="flex-1 overflow-y-auto py-2 dark:bg-zinc-900">
                            
                            {/* Auto Router Selection */}
                            {selectedProvider === 'favorites' && searchQuery === '' && (
                              <div
                                onClick={() => handleSelectModel('auto')}
                                className={`flex items-start justify-between p-2.5 mx-2 my-0.5 rounded-xl cursor-pointer transition-colors border ${
                                  selectedModel === 'auto'
                                    ? 'bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200/60 dark:border-zinc-800 shadow-[0_1px_2px_rgba(0,0,0,0.01)]'
                                    : 'hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 border-transparent'
                                }`}
                              >
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-zinc-800 dark:text-zinc-200 text-xs">Auto Router</span>
                                    <span className="text-emerald-600 dark:text-emerald-500 font-bold text-[9px] bg-emerald-50 dark:bg-emerald-950/40 px-1 py-0.25 rounded">$$</span>
                                    <Star className="size-3 fill-amber-400 text-amber-400" />
                                  </div>
                                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 font-normal">Automatically routes to the fastest, cheapest available engine.</p>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Sparkles className="size-3 text-indigo-500 fill-indigo-50 dark:fill-indigo-950/20" />
                                  <Info className="size-3 text-zinc-300 dark:text-zinc-500" />
                                </div>
                              </div>
                            )}

                            {/* Dynamically Filtered Real Models List */}
                            {allModels.current.length === 0 ? (
                              <div className="h-full flex flex-col items-center justify-center p-6 text-center select-none">
                                <SlidersHorizontal className="size-8 text-zinc-300 dark:text-zinc-700 animate-pulse" />
                                <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mt-3">No models configured yet</p>
                                <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 max-w-[220px] mt-1 leading-relaxed">
                                  Go to the Keys and Fallback settings pages to configure your API keys and enable models.
                                </p>
                              </div>
                            ) : filteredModels.length === 0 ? (
                              selectedProvider === 'favorites' ? (
                                <div className="h-full flex flex-col items-center justify-center p-6 text-center select-none">
                                  <Star className="size-8 text-zinc-300 dark:text-zinc-700 animate-pulse" />
                                  <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-400 mt-3">No favorites yet</p>
                                  <p className="text-[10.5px] text-zinc-400 dark:text-zinc-500 max-w-[200px] mt-1 leading-relaxed">
                                    Click the star icon next to any model to add it to your quick-access list!
                                  </p>
                                </div>
                              ) : (
                                <div className="h-full flex flex-col items-center justify-center p-4 text-center select-none">
                                  <span className="text-zinc-300 dark:text-zinc-700 text-2xl">🔍</span>
                                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">No configured models in this category.</p>
                                </div>
                              )
                            ) : (
                              filteredModels.map(model => (
                                <div
                                  key={model.id}
                                  onClick={() => handleSelectModel(model.id)}
                                  className={`flex items-start justify-between p-2.5 mx-2 my-0.5 rounded-xl cursor-pointer border transition-colors ${
                                    selectedModel === model.id
                                      ? 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200/60 dark:border-zinc-800 shadow-[0_1px_3px_rgba(0,0,0,0.02)]'
                                      : 'hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 border-transparent'
                                  }`}
                                >
                                  <div className="space-y-0.5 flex-1 pr-2">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-semibold text-zinc-800 dark:text-zinc-200 text-xs">{model.displayName}</span>
                                      
                                      {/* Color-coded Price Tier Badges */}
                                      <span className={`text-[9px] font-bold px-1 py-0.25 rounded ${
                                        model.priceTier === '$$$+' ? 'text-rose-600 bg-rose-50 dark:text-rose-500 dark:bg-rose-950/40' :
                                        model.priceTier === '$$$' ? 'text-amber-600 bg-amber-50 dark:text-amber-500 dark:bg-amber-950/40' :
                                        model.priceTier === '$$' ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-500 dark:bg-emerald-950/40' :
                                        'text-teal-600 bg-teal-50 dark:text-teal-500 dark:bg-teal-950/40'
                                      }`}>
                                        {model.priceTier}
                                      </span>

                                      {/* Interactive Star toggle */}
                                      <button
                                        type="button"
                                        onClick={(e) => toggleFavorite(model.id, e)}
                                        className="text-zinc-300 dark:text-zinc-500 hover:text-amber-400 dark:hover:text-amber-400 hover:scale-110 active:scale-95 transition-all outline-none"
                                      >
                                        <Star className={`size-3 ${model.isFavorite ? 'fill-amber-400 text-amber-400' : 'text-zinc-300 dark:text-zinc-500'}`} />
                                      </button>
                                    </div>
                                    <p className="text-[10px] text-zinc-400 dark:text-zinc-400 leading-relaxed font-normal">{model.description}</p>
                                  </div>

                                  {/* Right side capability indicators */}
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <div className="flex items-center gap-0.5 text-zinc-400 dark:text-zinc-600">
                                      {model.capabilities.vision && <span title="Vision Multimodal support"><Eye className="size-3 text-sky-500 dark:text-sky-400" /></span>}
                                      {model.capabilities.reasoning && <span title="High Reasoning Intelligence"><Brain className="size-3 text-purple-500 dark:text-purple-400" /></span>}
                                      {model.capabilities.context && <span title="Large Context Long Documents"><FileText className="size-3 text-indigo-500 dark:text-indigo-400" /></span>}
                                      {model.capabilities.image && <span title="Image Generation support"><ImageIcon className="size-3 text-rose-500 dark:text-rose-500" /></span>}
                                    </div>
                                    <Info className="size-3 text-zinc-300 dark:text-zinc-500 hover:text-zinc-400 dark:hover:text-zinc-500 transition-colors" />
                                  </div>
                                </div>
                              ))
                            )}

                          </div>
                        </div>

                      </div>
                    )}
                  </div>

                  {/* Document Attachment Button (Attach Only) */}
                  <button
                    type="button"
                    onClick={handleAttachClick}
                    className="flex items-center gap-1 px-3 py-1.5 bg-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-800 rounded-full text-xs font-semibold text-zinc-500 dark:text-zinc-400 transition-colors cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.01)]"
                  >
                    <Paperclip className="size-3.5 text-zinc-400 dark:text-zinc-500" />
                    <span>Attach</span>
                  </button>

                </div>

                {/* Submitting Circular Button */}
                <button
                  type="button"
                  onClick={() => handleSend()}
                  disabled={loading || !input.trim()}
                  className={`size-8 rounded-full flex items-center justify-center text-white dark:text-zinc-950 transition-all cursor-pointer ${
                    loading || !input.trim()
                      ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 border border-zinc-200/20 dark:border-zinc-800/40 cursor-not-allowed'
                      : 'bg-zinc-900 dark:bg-zinc-100 hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-95 shadow-[0_2px_6px_rgba(0,0,0,0.08)] dark:shadow-[0_2px_6px_rgba(255,255,255,0.05)]'
                  }`}
                  title="Send message"
                >
                  {loading ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  ) : (
                    <ArrowUp className="size-4" strokeWidth={2.5} />
                  )}
                </button>

              </div>

            </div>

          </div>
        </div>

      </div>
    </div>
  )
}
