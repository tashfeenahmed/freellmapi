import { useState, useEffect, useRef } from 'react'
import { Send, Loader2, Bot, User, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Model {
  id: string
  displayName: string
  platform: string
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string
  timestamp: number
}

interface ChatResponse {
  choices: Array<{
    message: {
      role: string
      content: string
    }
  }>
  model?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export function ChatInterface() {
  const [models, setModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [fallbackChain, setFallbackChain] = useState<string[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Fetch available models
  useEffect(() => {
    fetch('/v1/models')
      .then((res) => res.json())
      .then((data) => {
        const modelList = data.data || data.models || []
        setModels(modelList)
        if (modelList.length > 0 && !selectedModel) {
          setSelectedModel(modelList[0].id)
        }
      })
      .catch((err) => {
        setError(`Failed to load models: ${err.message}`)
      })
  }, [])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addToFallbackChain = (modelId: string) => {
    if (!fallbackChain.includes(modelId) && modelId !== selectedModel) {
      setFallbackChain([...fallbackChain, modelId])
    }
  }

  const removeFromFallbackChain = (modelId: string) => {
    setFallbackChain(fallbackChain.filter((id) => id !== modelId))
  }

  const sendMessage = async () => {
    if (!input.trim() || !selectedModel) return

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    }

    setMessages([...messages, userMessage])
    setInput('')
    setIsLoading(true)
    setError(null)

    try {
      // Build the request - lmesh's routing will handle fallback automatically
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: input },
          ],
          stream: false,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data: ChatResponse = await response.json()

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.choices[0]?.message?.content || 'No response',
        model: data.model || selectedModel,
        timestamp: Date.now(),
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch (err: any) {
      setError(err.message || 'Failed to send message')
      const errorMessage: Message = {
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Sidebar - Model Selection */}
      <div className="w-80 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
          Model Selection
        </h2>

        {/* Primary Model */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Primary Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName || model.id}
              </option>
            ))}
          </select>
        </div>

        {/* Fallback Chain */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Fallback Chain ({fallbackChain.length})
          </label>
          <div className="space-y-2 mb-2">
            {fallbackChain.map((modelId, idx) => {
              const model = models.find((m) => m.id === modelId)
              return (
                <div
                  key={modelId}
                  className="flex items-center justify-between px-3 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-md"
                >
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {idx + 1}. {model?.displayName || modelId}
                  </span>
                  <button
                    onClick={() => removeFromFallbackChain(modelId)}
                    className="text-red-500 hover:text-red-700 text-sm"
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          <select
            onChange={(e) => {
              if (e.target.value) {
                addToFallbackChain(e.target.value)
                e.target.value = ''
              }
            }}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            value=""
          >
            <option value="">+ Add fallback model...</option>
            {models
              .filter((m) => m.id !== selectedModel && !fallbackChain.includes(m.id))
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName || model.id}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Note: Fallback chain is managed by lmesh's routing system. The primary model
            is tried first, then fallbacks automatically.
          </p>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
                Chat with {models.find((m) => m.id === selectedModel)?.displayName || selectedModel}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {fallbackChain.length > 0
                  ? `With ${fallbackChain.length} fallback model${fallbackChain.length > 1 ? 's' : ''}`
                  : 'No fallbacks configured'}
              </p>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <Bot className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400">
                  Start a conversation by typing a message below
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4 max-w-3xl mx-auto">
              {messages.map((message, idx) => (
                <div
                  key={idx}
                  className={`flex gap-3 ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.role !== 'user' && (
                    <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                      {message.role === 'system' ? (
                        <AlertCircle className="w-5 h-5 text-white" />
                      ) : (
                        <Bot className="w-5 h-5 text-white" />
                      )}
                    </div>
                  )}
                  <div
                    className={`max-w-[70%] rounded-lg px-4 py-2 ${
                      message.role === 'user'
                        ? 'bg-blue-500 text-white'
                        : message.role === 'system'
                        ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                        : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700'
                    }`}
                  >
                    {message.model && message.role === 'assistant' && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                        {message.model}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{message.content}</div>
                  </div>
                  {message.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-500 flex items-center justify-center flex-shrink-0">
                      <User className="w-5 h-5 text-white" />
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mx-6 mb-2 px-4 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-4">
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Type your message..."
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-none"
              rows={2}
              disabled={isLoading}
            />
            <Button
              onClick={sendMessage}
              disabled={isLoading || !input.trim() || !selectedModel}
              className="px-6"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
