import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState('')

  const { data: currentPrompt = { prompt: '' } } = useQuery<{ prompt: string }>({
    queryKey: ['system-prompt'],
    queryFn: () => apiFetch('/api/settings/system-prompt'),
  })

  const savePrompt = useMutation({
    mutationFn: (body: { prompt: string }) =>
      apiFetch('/api/settings/system-prompt', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-prompt'] })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    savePrompt.mutate({ prompt })
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Global proxy settings that affect all routed requests."
      />

      <section className="rounded-3xl border bg-card p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label className="text-sm font-medium">Default System Prompt</Label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-2">
              Injected at proxy level so every model gets the same base persona regardless of failover.
              Only applied when the client does not send their own system message.
            </p>
          </div>

          <Textarea
            value={prompt || currentPrompt.prompt || ''}
            onChange={e => setPrompt(e.target.value)}
            placeholder="You are a helpful, concise assistant..."
            className="min-h-[160px] font-mono text-sm"
            rows={8}
          />

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={savePrompt.isPending}>
              {savePrompt.isPending ? 'Saving…' : 'Save'}
            </Button>
            {savePrompt.isPending && (
              <span className="text-xs text-muted-foreground">Saving…</span>
            )}
            {savePrompt.isSuccess && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>
            )}
          </div>

          {savePrompt.isError && (
            <p className="text-destructive text-xs">
              {(savePrompt.error as Error).message}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Leave empty to disable. Client-provided system messages always take precedence.
          </p>
        </form>
      </section>
    </div>
  )
}