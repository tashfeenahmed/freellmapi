import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Download } from 'lucide-react'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/lib/toast'
import type { ApiKey } from '../../../../shared/types'

type ExportFormat = 'json' | 'env' | 'csv'

const FORMAT_OPTIONS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: 'json', label: 'JSON', ext: 'json' },
  { value: 'env', label: '.env', ext: 'env' },
  { value: 'csv', label: 'CSV', ext: 'csv' },
]

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function downloadExport(format: ExportFormat, healthyOnly: boolean) {
  const token = getToken()
  const params = new URLSearchParams({ format })
  if (healthyOnly) params.set('healthy', 'true')
  const res = await fetch(`${BASE}/api/keys/export?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const ext = FORMAT_OPTIONS.find(f => f.value === format)?.ext ?? format
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `freellmapi-keys.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}

export function ExportKeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const [format, setFormat] = useState<ExportFormat>('json')
  const [healthyOnly, setHealthyOnly] = useState(false)
  const [exporting, setExporting] = useState(false)

  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const exportableKeys = keys.filter(k => !k.keyless)
  const exportCount = healthyOnly
    ? exportableKeys.filter(k => k.status === 'healthy').length
    : exportableKeys.length

  async function handleExport() {
    setExporting(true)
    try {
      await downloadExport(format, healthyOnly)
      toast.success(t('keys.exportSuccess', { count: exportCount }))
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.exportKeys')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs">{t('keys.exportFormat')}</Label>
            <div className="flex gap-2">
              {FORMAT_OPTIONS.map(opt => (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={format === opt.value ? 'default' : 'outline'}
                  onClick={() => setFormat(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label className="text-xs">{t('keys.exportHealthyOnly')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('keys.exportHealthyOnlyDesc')}
              </p>
            </div>
            <Switch
              size="sm"
              checked={healthyOnly}
              onCheckedChange={setHealthyOnly}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span>{t('keys.exportWillExport')}</span>
            <span className="font-medium text-foreground">
              {exportCount} {exportCount === 1 ? t('keys.exportKey') : t('keys.exportKeys plural')}
            </span>
          </div>

          <Button
            type="button"
            className="w-full"
            onClick={handleExport}
            disabled={exporting || exportCount === 0}
          >
            <Download className="size-3.5" />
            {exporting ? t('keys.exporting') : t('keys.exportDownload')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
