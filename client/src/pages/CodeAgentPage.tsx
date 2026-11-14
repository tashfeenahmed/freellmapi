import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Download, FilePlus2, FolderPlus, Folder, FileText, Pencil, RefreshCw, Save, Trash2, Upload, Send } from 'lucide-react'
import { apiFetch, getToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Node = { name: string; path: string; type: 'file' | 'directory'; size?: number; children?: Node[] }

async function apiBlob(path: string): Promise<Blob> {
  const token = getToken()
  const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
  return res.blob()
}

function Tree({
  nodes, depth = 0, selected, onSelect, onDelete,
}: { nodes: Node[]; depth?: number; selected: string | null; onSelect: (n: Node) => void; onDelete: (n: Node) => void }) {
  return (
    <div>
      {nodes.map(n => (
        <div key={n.path}>
          <div
            className={`group flex items-center gap-1.5 px-2 py-1 text-sm cursor-pointer border-l ${selected === n.path ? 'bg-black text-white border-black' : 'hover:bg-neutral-100 border-transparent'}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onSelect(n)}
          >
            {n.type === 'directory' ? <Folder className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
            <span className="truncate flex-1">{n.name}</span>
            <button
              className={`opacity-0 group-hover:opacity-100 p-0.5 ${selected === n.path ? 'hover:bg-white/20' : 'hover:bg-neutral-200'}`}
              title="Delete"
              onClick={(e) => { e.stopPropagation(); onDelete(n) }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
          {n.type === 'directory' && n.children?.length ? (
            <Tree nodes={n.children} depth={depth + 1} selected={selected} onSelect={onSelect} onDelete={onDelete} />
          ) : null}
        </div>
      ))}
    </div>
  )
}

type Msg = { role: 'user' | 'assistant'; content: string }

export default function CodeAgentPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Node | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', content: 'Code Agent ready. I can edit, create, and delete files/folders in this workspace. Ask me to make changes or use the tools on the left.' }])
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const treeQ = useQuery<{ root: string; entries: Node[] }>({
    queryKey: ['code-agent', 'tree'],
    queryFn: () => apiFetch('/api/code-agent/tree'),
  })

  const loadFile = useCallback(async (n: Node) => {
    if (n.type !== 'file') return
    const data = await apiFetch<{ path: string; content: string }>('/api/code-agent/file?path=' + encodeURIComponent(n.path))
    setSelected(n)
    setContent(data.content)
    setDirty(false)
  }, [])

  const save = async () => {
    if (!selected || selected.type !== 'file') return
    await apiFetch('/api/code-agent/file', { method: 'PUT', body: JSON.stringify({ path: selected.path, content }) })
    setDirty(false)
    qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
  }

  const createFile = async () => {
    const p = newPath.trim()
    if (!p) return
    await apiFetch('/api/code-agent/file', { method: 'PUT', body: JSON.stringify({ path: p, content: '' }) })
    setNewPath('')
    qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
  }
  const createFolder = async () => {
    const p = newPath.trim()
    if (!p) return
    await apiFetch('/api/code-agent/mkdir', { method: 'POST', body: JSON.stringify({ path: p }) })
    setNewPath('')
    qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
  }
  const del = async (n: Node) => {
    if (!confirm(`Delete ${n.path}?`)) return
    await apiFetch('/api/code-agent/path?path=' + encodeURIComponent(n.path), { method: 'DELETE' })
    if (selected?.path === n.path) { setSelected(null); setContent('') }
    qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
  }

  const uploadZip = async (f: File) => {
    const fd = new FormData()
    fd.append('file', f)
    const token = getToken()
    const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/code-agent/upload-zip`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: fd,
    })
    if (!res.ok) throw new Error(await res.text())
    qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
  }

  const downloadZip = async () => {
    const blob = await apiBlob('/api/code-agent/download-zip')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'workspace.zip'; a.click()
    URL.revokeObjectURL(url)
  }

  const send = async () => {
    const text = prompt.trim()
    if (!text || sending) return
    const next = [...msgs, { role: 'user' as const, content: text }]
    setMsgs(next); setPrompt(''); setSending(true)
    try {
      const data = await apiFetch<{ message?: { content?: string }; steps?: any[]; error?: any }>('/api/code-agent/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: next }),
      })
      const reply = data?.message?.content || (data?.error?.message ? `Error: ${data.error.message}` : 'Done.')
      const stepNote = data?.steps?.length ? `\n\n[actions: ${data.steps.map((s: any) => s.tool).join(', ')}]` : ''
      setMsgs(m => [...m, { role: 'assistant', content: reply + stepNote }])
      qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })
      if (selected?.type === 'file') loadFile(selected).catch(() => {})
    } catch (e: any) {
      setMsgs(m => [...m, { role: 'assistant', content: `Error: ${e?.message || e}` }])
    } finally { setSending(false) }
  }

  return (
    <div className="h-[calc(100vh-5.5rem)] min-h-[600px] bg-white text-black border-x border-b border-black">
      <div className="border-b border-black px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2"><Bot className="size-5" /> Code Agent</h1>
          <p className="text-xs text-neutral-600">MonkeyCode-style workspace agent · edit, create, delete files/folders · upload & download zip</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadZip(f).catch(err => alert(String(err))); e.target.value = '' }} />
          <Button variant="outline" size="sm" className="border-black text-black hover:bg-black hover:text-white" onClick={() => fileRef.current?.click()}><Upload className="size-4 mr-1" />Upload ZIP</Button>
          <Button variant="outline" size="sm" className="border-black text-black hover:bg-black hover:text-white" onClick={downloadZip}><Download className="size-4 mr-1" />Download ZIP</Button>
          <Button variant="outline" size="sm" className="border-black text-black hover:bg-black hover:text-white" onClick={() => qc.invalidateQueries({ queryKey: ['code-agent', 'tree'] })}><RefreshCw className="size-4" /></Button>
        </div>
      </div>

      <div className="grid grid-cols-12 h-[calc(100vh-11rem)]">
        <div className="col-span-3 border-r border-black flex flex-col min-h-0">
          <div className="p-2 border-b border-black space-y-2">
            <div className="flex gap-1">
              <Input value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="path/to/file-or-folder" className="h-8 border-black rounded-none text-xs" />
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-xs border-black rounded-none hover:bg-black hover:text-white flex-1" onClick={createFile}><FilePlus2 className="size-3.5 mr-1" />File</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs border-black rounded-none hover:bg-black hover:text-white flex-1" onClick={createFolder}><FolderPlus className="size-3.5 mr-1" />Folder</Button>
            </div>
            <div className="text-[10px] text-neutral-500 break-all">{treeQ.data?.root}</div>
          </div>
          <div className="flex-1 overflow-auto">
            {treeQ.isLoading ? <div className="p-3 text-sm text-neutral-500">Loading…</div> :
              treeQ.data?.entries?.length ? <Tree nodes={treeQ.data.entries} selected={selected?.path ?? null} onSelect={n => n.type === 'file' ? loadFile(n) : setSelected(n)} onDelete={del} /> :
              <div className="p-3 text-sm text-neutral-500">Workspace empty. Create files, ask the agent, or upload a zip.</div>}
          </div>
        </div>

        <div className="col-span-5 border-r border-black flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-black flex items-center justify-between">
            <div className="text-sm font-medium truncate">{selected?.path || 'No file selected'}</div>
            <Button size="sm" className="h-7 rounded-none bg-black text-white hover:bg-neutral-800" disabled={!dirty || !selected || selected.type !== 'file'} onClick={save}><Save className="size-3.5 mr-1" />Save</Button>
          </div>
          <div className="flex-1 min-h-0">
            {selected?.type === 'file' ? (
              <textarea
                value={content}
                onChange={e => { setContent(e.target.value); setDirty(true) }}
                className="w-full h-full resize-none p-3 font-mono text-sm outline-none bg-white text-black"
                spellCheck={false}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-neutral-500 text-sm p-6 text-center">Select a file to view and edit, or ask the agent to create/modify files.</div>
            )}
          </div>
        </div>

        <div className="col-span-4 flex flex-col min-h-0 bg-white">
          <div className="px-3 py-2 border-b border-black font-medium text-sm">Agent Chat</div>
          <div className="flex-1 overflow-auto p-3 space-y-3 bg-white">
            {msgs.map((m, i) => (
              <div key={i} className={`text-sm whitespace-pre-wrap p-2 border ${m.role === 'user' ? 'bg-white border-black ml-6' : 'bg-black text-white border-black mr-2'}`}>{m.content}</div>
            ))}
            {sending && <div className="text-sm text-neutral-500">Agent working…</div>}
          </div>
          <div className="p-2 border-t border-black bg-white space-y-2">
            <Textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask the agent to create, edit, or delete files…" className="min-h-[80px] border-black rounded-none text-sm" onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-neutral-500">Ctrl/Cmd+Enter to send · uses configured models via /v1</span>
              <Button className="rounded-none bg-black text-white hover:bg-neutral-800 h-8" onClick={send} disabled={sending || !prompt.trim()}><Send className="size-4 mr-1" />Send</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}