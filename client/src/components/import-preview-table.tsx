"use client"

import { useState, useEffect } from "react"
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PreviewKey {
  keyName: string
  keyValue: string
  detectedPlatform: string | null
  prefix: string
}

export interface ImportKey {
  keyName: string
  keyValue: string
  platform: string
}

// ── Platform options ───────────────────────────────────────────────────────────

const PLATFORM_OPTIONS = [
  { value: "google", label: "Google AI Studio" },
  { value: "groq", label: "Groq" },
  { value: "cerebras", label: "Cerebras" },
  { value: "sambanova", label: "SambaNova" },
  { value: "nvidia", label: "NVIDIA NIM" },
  { value: "mistral", label: "Mistral" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "github", label: "GitHub Models" },
  { value: "cohere", label: "Cohere" },
  { value: "cloudflare", label: "Cloudflare Workers AI" },
  { value: "zhipu", label: "Zhipu AI (Z.ai)" },
  { value: "ollama", label: "Ollama Cloud" },
  { value: "opencode", label: "OpenCode Zen" },
  { value: "kilo", label: "Kilo Gateway (anon ok)" },
  { value: "pollinations", label: "Pollinations (anon ok)" },
  { value: "llm7", label: "LLM7 (anon ok)" },
  { value: "huggingface", label: "HuggingFace Router" },
]

const VALID_PLATFORM_VALUES = new Set(PLATFORM_OPTIONS.map(p => p.value))

function resolvePlatform(detected: string | null): string {
  if (detected && VALID_PLATFORM_VALUES.has(detected)) return detected
  return "google"
}

// ── Row state ──────────────────────────────────────────────────────────────────

interface RowState {
  checked: boolean
  platform: string
  keyName: string
  keyValue: string
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface ImportPreviewTableProps {
  keys: PreviewKey[]
  onSelectionChange: (selected: ImportKey[]) => void
}

// ── Component ──────────────────────────────────────────────────────────────────

function ImportPreviewTable({ keys, onSelectionChange }: ImportPreviewTableProps) {
  const [rows, setRows] = useState<RowState[]>([])
  const [showPasswords, setShowPasswords] = useState<Record<number, boolean>>({})

  // Initialise row state from preview keys
  useEffect(() => {
    setRows(
      keys.map(k => ({
        checked: true,
        platform: resolvePlatform(k.detectedPlatform),
        keyName: k.keyName,
        keyValue: k.keyValue,
      }))
    )
    setShowPasswords({})
  }, [keys])

  // Notify parent when selection changes
  useEffect(() => {
    const selected: ImportKey[] = rows
      .filter(r => r.checked)
      .map(r => ({
        keyName: r.keyName,
        keyValue: r.keyValue,
        platform: r.platform,
      }))
    onSelectionChange(selected)
  }, [rows, onSelectionChange])

  // ── Handlers ───────────────────────────────────────────────────────────────

  function toggleChecked(index: number) {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, checked: !r.checked } : r)))
  }

  function changePlatform(index: number, platform: string) {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, platform } : r)))
  }

  function changeKeyValue(index: number, keyValue: string) {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, keyValue } : r)))
  }

  function toggleShowPassword(index: number) {
    setShowPasswords(prev => ({ ...prev, [index]: !prev[index] }))
  }

  // ── Empty state ────────────────────────────────────────────────────────────

  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">No keys found in uploaded files</p>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Select</TableHead>
            <TableHead>Platform</TableHead>
            <TableHead>Key Name</TableHead>
            <TableHead>Key Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={() => toggleChecked(i)}
                  className="size-4 accent-primary"
                />
              </TableCell>
              <TableCell>
                <Select value={row.platform} onValueChange={(v) => changePlatform(i, v ?? "google")}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="font-mono text-sm max-w-[200px] truncate">
                {row.keyName}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Input
                    type={showPasswords[i] ? "text" : "password"}
                    value={row.keyValue}
                    onChange={(e) => changeKeyValue(i, e.target.value)}
                    className="font-mono text-xs flex-1 min-w-[200px]"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleShowPassword(i)}
                    className="shrink-0"
                  >
                    {showPasswords[i] ? "Hide" : "Show"}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export { ImportPreviewTable }
