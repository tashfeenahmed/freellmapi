import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { X, Copy, Clipboard, Pencil, Sparkles, Loader2 } from 'lucide-react'

interface CostModel {
    id: number
    platform: string
    modelId: string
    displayName: string
    inputCostPer1M: number | null
    outputCostPer1M: number | null
    costUpdatedAt: string | null
}

function formatDateTime(iso: string | null): string {
    if (!iso) return 'Not updated'
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export default function CostPage() {
    const queryClient = useQueryClient()
    const [jsonOpen, setJsonOpen] = useState(false)
    const [jsonText, setJsonText] = useState('')
    const [jsonError, setJsonError] = useState('')
    const [aiWarningOpen, setAiWarningOpen] = useState(false)
    const [aiLoading, setAiLoading] = useState(false)
    const [aiError, setAiError] = useState('')
    const [editCell, setEditCell] = useState<{ id: number; field: 'input' | 'output' } | null>(null)
    const [editValue, setEditValue] = useState('')

    const { data, isLoading } = useQuery<{ models: CostModel[] }>({
        queryKey: ['cost-models'],
        queryFn: () => apiFetch('/api/cost'),
    })

    const models = data?.models ?? []

    // Sort: unconfigured (missing either price) first, then by platform + name
    const sorted = [...models].sort((a, b) => {
        const aConfigured = a.inputCostPer1M != null && a.outputCostPer1M != null ? 1 : 0
        const bConfigured = b.inputCostPer1M != null && b.outputCostPer1M != null ? 1 : 0
        if (aConfigured !== bConfigured) return aConfigured - bConfigured
        if (a.platform !== b.platform) return a.platform.localeCompare(b.platform)
        return a.displayName.localeCompare(b.displayName)
    })

    const updateMutation = useMutation({
        mutationFn: (payload: { models: Array<{ id: number; inputCostPer1M?: number | null; outputCostPer1M?: number | null }> }) =>
            apiFetch('/api/cost', {
                method: 'PUT',
                body: JSON.stringify(payload),
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['cost-models'] })
            setJsonOpen(false)
            setJsonText('')
            setJsonError('')
        },
    })

    const inlineUpdateMutation = useMutation({
        mutationFn: (payload: { models: Array<{ id: number; inputCostPer1M?: number | null; outputCostPer1M?: number | null }> }) =>
            apiFetch('/api/cost', {
                method: 'PUT',
                body: JSON.stringify(payload),
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['cost-models'] })
        },
    })

    function openJsonEditor() {
        const payload = [...models]
            .sort((a, b) => {
                const aConfigured = a.inputCostPer1M != null && a.outputCostPer1M != null ? 1 : 0
                const bConfigured = b.inputCostPer1M != null && b.outputCostPer1M != null ? 1 : 0
                if (aConfigured !== bConfigured) return aConfigured - bConfigured
                if (a.platform !== b.platform) return a.platform.localeCompare(b.platform)
                return a.displayName.localeCompare(b.displayName)
            })
            .map(m => ({
                id: m.id,
                provider: m.platform,
                model: m.modelId,
                displayName: m.displayName,
                inputCostPer1M: m.inputCostPer1M,
                outputCostPer1M: m.outputCostPer1M,
            }))
        setJsonText(JSON.stringify(payload, null, 2))
        setJsonError('')
        setJsonOpen(true)
    }

    function saveJson() {
        try {
            const parsed = JSON.parse(jsonText)
            if (!Array.isArray(parsed)) {
                setJsonError('Expected an array of model objects')
                return
            }
            const payload = parsed.map((item: any) => ({
                id: Number(item.id),
                inputCostPer1M: item.inputCostPer1M === undefined || item.inputCostPer1M === null ? null : Number(item.inputCostPer1M),
                outputCostPer1M: item.outputCostPer1M === undefined || item.outputCostPer1M === null ? null : Number(item.outputCostPer1M),
            }))
            updateMutation.mutate({ models: payload })
        } catch (e: any) {
            setJsonError(e.message ?? 'Invalid JSON')
        }
    }

    function startCellEdit(m: CostModel, field: 'input' | 'output') {
        setEditCell({ id: m.id, field })
        const val = field === 'input' ? m.inputCostPer1M : m.outputCostPer1M
        setEditValue(val !== null && val !== undefined ? String(val) : '')
    }

    async function saveCellEdit() {
        if (!editCell) return
        const currentCell = editCell
        const payload = {
            models: [{
                id: editCell.id,
                inputCostPer1M: editCell.field === 'input' ? (editValue === '' ? null : Number(editValue)) : undefined,
                outputCostPer1M: editCell.field === 'output' ? (editValue === '' ? null : Number(editValue)) : undefined,
            }]
        }
        setEditCell(null)
        try {
            await inlineUpdateMutation.mutateAsync(payload)
        } catch {
            setEditCell(currentCell)
        }
    }

    function handleCellKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter') saveCellEdit()
        if (e.key === 'Escape') setEditCell(null)
    }

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(jsonText)
        } catch {
            const ta = document.createElement('textarea')
            ta.value = jsonText
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
        }
    }

    async function handlePaste() {
        try {
            const text = await navigator.clipboard.readText()
            setJsonText(text)
            setJsonError('')
            setAiError('')
        } catch {
            setJsonError('Unable to read clipboard. Please paste manually.')
        }
    }

    async function handleAiUpdate() {
        setAiWarningOpen(false)
        setAiLoading(true)
        setAiError('')
        setJsonError('')

        try {
            const { apiKey } = await apiFetch<{ apiKey: string }>('/api/settings/api-key')
            if (!apiKey) {
                throw new Error('No API key configured. Please set up an API key in Settings.')
            }

            const base = import.meta.env.BASE_URL.replace(/\/$/, '')
            const prompt = `You are a pricing research assistant for AI language models.
Your task: research the CURRENT live pricing (input cost per 1M tokens and output cost per 1M tokens in USD) for every model in the provided JSON array.
Rules:
- Return ONLY a valid JSON array. No markdown fences, no explanations, no extra text.
- Preserve every field (id, provider, model, displayName) exactly as given.
- Only update inputCostPer1M and outputCostPer1M with accurate current prices.
- If a price is unknown, set it to null.
- All numbers must be plain numbers (not strings).

Input JSON:
${jsonText}`

            const res = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant that returns only valid JSON.' },
                        { role: 'user', content: prompt },
                    ],
                    model: 'auto',
                }),
            })

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
                throw new Error(err.error?.message ?? `AI request failed: HTTP ${res.status}`)
            }

            const data = await res.json()
            const content = data.choices?.[0]?.message?.content ?? ''

            let jsonStr = content.trim()
            const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
            if (fenceMatch) jsonStr = fenceMatch[1].trim()

            const parsed = JSON.parse(jsonStr)
            if (!Array.isArray(parsed)) {
                throw new Error('AI response was not a JSON array.')
            }

            setJsonText(JSON.stringify(parsed, null, 2))
        } catch (err: any) {
            setAiError(err.message ?? 'Failed to update via AI')
        } finally {
            setAiLoading(false)
        }
    }

    return (
        <div>
            <PageHeader
                title="Pricing"
                description="Manage per-model pricing for accurate cost estimates."
                actions={
                    <Button size="sm" onClick={openJsonEditor}>
                        Edit JSON
                    </Button>
                }
            />

            <div className="rounded-3xl border bg-card">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                    <h3 className="text-sm font-medium">Model Pricing</h3>
                    <div className="flex gap-2">
                        <Badge variant="secondary">{models.length} models</Badge>
                        <Badge variant="destructive">
                            {models.filter(m => m.inputCostPer1M == null || m.outputCostPer1M == null).length} not updated
                        </Badge>
                    </div>
                </div>

                <div className="p-4">
                    {isLoading ? (
                        <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
                    ) : sorted.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">No models found.</p>
                    ) : (
                        <div className="max-h-[600px] overflow-y-auto -mx-4">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="pl-4">Model</TableHead>
                                        <TableHead>Provider</TableHead>
                                        <TableHead className="text-right">Input ($/1M)</TableHead>
                                        <TableHead className="text-right">Output ($/1M)</TableHead>
                                        <TableHead className="text-right pr-4">Last Updated</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sorted.map((m) => {
                                        const isConfigured = m.inputCostPer1M != null && m.outputCostPer1M != null
                                        const editingInput = editCell?.id === m.id && editCell?.field === 'input'
                                        const editingOutput = editCell?.id === m.id && editCell?.field === 'output'
                                        return (
                                            <TableRow key={m.id} className={!isConfigured ? 'bg-destructive/5' : undefined}>
                                                <TableCell className="pl-4 text-sm font-medium">
                                                    <div className="flex items-center gap-2">
                                                        {m.displayName}
                                                        {!isConfigured && <Badge variant="destructive" className="text-[10px] px-1 py-0">NEW</Badge>}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-xs text-muted-foreground capitalize">{m.platform}</TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {editingInput ? (
                                                        <Input
                                                            type="number"
                                                            step="0.01"
                                                            autoFocus
                                                            value={editValue}
                                                            onChange={(e) => setEditValue(e.target.value)}
                                                            onKeyDown={handleCellKeyDown}
                                                            onBlur={saveCellEdit}
                                                            className="h-7 w-24 text-xs text-right inline-block [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                                        />
                                                    ) : (
                                                        <button
                                                            className="inline-flex items-center gap-1 group cursor-text"
                                                            onClick={() => startCellEdit(m, 'input')}
                                                        >
                                                            <span>
                                                                {m.inputCostPer1M !== null && m.inputCostPer1M !== undefined
                                                                    ? `$${m.inputCostPer1M.toFixed(2)}`
                                                                    : '—'}
                                                            </span>
                                                            <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                                        </button>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {editingOutput ? (
                                                        <Input
                                                            type="number"
                                                            step="0.01"
                                                            autoFocus
                                                            value={editValue}
                                                            onChange={(e) => setEditValue(e.target.value)}
                                                            onKeyDown={handleCellKeyDown}
                                                            onBlur={saveCellEdit}
                                                            className="h-7 w-24 text-xs text-right inline-block [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                                        />
                                                    ) : (
                                                        <button
                                                            className="inline-flex items-center gap-1 group cursor-text"
                                                            onClick={() => startCellEdit(m, 'output')}
                                                        >
                                                            <span>
                                                                {m.outputCostPer1M !== null && m.outputCostPer1M !== undefined
                                                                    ? `$${m.outputCostPer1M.toFixed(2)}`
                                                                    : '—'}
                                                            </span>
                                                            <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                                        </button>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right text-xs tabular-nums pr-4">
                                                    {!isConfigured ? (
                                                        <span className="text-destructive font-medium">Not updated</span>
                                                    ) : (
                                                        <span className="text-muted-foreground">{formatDateTime(m.costUpdatedAt)}</span>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>
            </div>

            {/* JSON Editor Modal */}
            {jsonOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-[95vw] h-[92vh] flex flex-col rounded-3xl border bg-card shadow-2xl overflow-hidden">
                        {/* Header */}
                        <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
                            <div>
                                <h3 className="text-sm font-medium">Edit Pricing JSON</h3>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    Paste updated prices from AI research. Only <code>inputCostPer1M</code> and{' '}
                                    <code>outputCostPer1M</code> fields are saved.
                                </p>
                            </div>
                            <Button variant="ghost" size="icon" onClick={() => setJsonOpen(false)}>
                                <X className="size-4" />
                            </Button>
                        </div>

                        {/* Toolbar */}
                        <div className="px-5 py-2 border-b flex items-center gap-2 shrink-0 bg-muted/30">
                            <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
                                <Copy className="size-3.5" /> Copy
                            </Button>
                            <Button variant="outline" size="sm" onClick={handlePaste} className="gap-1.5">
                                <Clipboard className="size-3.5" /> Paste
                            </Button>
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-background border text-xs text-muted-foreground">
                                <Pencil className="size-3" /> Editing
                            </div>
                            <div className="flex-1" />
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setAiWarningOpen(true)}
                                disabled={aiLoading}
                                className="gap-1.5"
                            >
                                {aiLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                Update by AI
                            </Button>
                        </div>

                        {/* Textarea */}
                        <div className="flex-1 min-h-0 p-4">
                            <Textarea
                                value={jsonText}
                                onChange={(e) => {
                                    setJsonText(e.target.value)
                                    setJsonError('')
                                    setAiError('')
                                }}
                                className="w-full h-full resize-none font-mono text-xs leading-relaxed"
                            />
                        </div>

                        {/* Errors */}
                        {(jsonError || aiError) && (
                            <div className="px-5 py-2 border-t shrink-0 space-y-1">
                                {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}
                                {aiError && <p className="text-sm text-destructive">{aiError}</p>}
                            </div>
                        )}

                        {/* Footer */}
                        <div className="px-5 py-3 border-t flex justify-end gap-2 shrink-0">
                            <Button variant="ghost" onClick={() => setJsonOpen(false)}>
                                Cancel
                            </Button>
                            <Button onClick={saveJson} disabled={updateMutation.isPending}>
                                {updateMutation.isPending ? 'Saving...' : 'Save'}
                            </Button>
                        </div>
                    </div>

                    {/* AI Warning Popup */}
                    {aiWarningOpen && (
                        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
                            <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-xl space-y-4">
                                <h4 className="text-sm font-medium">Update via AI</h4>
                                <p className="text-sm text-muted-foreground leading-relaxed">
                                    It will be better to copy the JSON and use ChatGPT or any AI that has browsing ability, so that you can get more accurate costs.
                                </p>
                                <div className="flex justify-end gap-2">
                                    <Button variant="destructive" size="sm" onClick={() => setAiWarningOpen(false)}>
                                        I will do by ChatGPT
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={handleAiUpdate}
                                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                    >
                                        Proceed anyway
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
