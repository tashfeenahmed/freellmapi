import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ImportKey, ImportSelectedResponse, Platform, PreviewKey, PreviewResponse } from '../../../../shared/types'
import { Upload } from 'lucide-react'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { PLATFORMS } from './shared'

interface ImportRow extends PreviewKey {
  selected: boolean
  platform: Platform | ''
  visible: boolean
  isDuplicate: boolean
}

// Always rendered inside the Add key dialog: no outer section chrome/heading.
// `onImported` lets that dialog close (and surface a result toast) once a batch
// import succeeds.
export function ImportKeysSection({ onImported }: { onImported?: () => void } = {}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<File[]>([])
  const [rows, setRows] = useState<ImportRow[]>([])
  const [skipped, setSkipped] = useState<string[]>([])

  const importablePlatforms = PLATFORMS.filter(p => !p.keyless)

  function platformFromPreview(key: PreviewKey): Platform | '' {
    return importablePlatforms.some(p => p.value === key.detectedPlatform)
      ? key.detectedPlatform as Platform
      : ''
  }

  const preview = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (nextFiles: File[]) => {
      const formData = new FormData()
      nextFiles.forEach(file => formData.append('files', file))
      return apiFetch<PreviewResponse>('/api/keys/preview', { method: 'POST', body: formData })
    },
    onSuccess: (data) => {
      setRows(data.keys.map(key => {
        const detected = platformFromPreview(key)
        return {
          ...key,
          platform: detected,
          selected: detected !== '' && !key.isDuplicate,
          visible: false,
          isDuplicate: key.isDuplicate ?? false,
        }
      }))
      setSkipped(data.skipped)
    },
  })

  const importSelected = useMutation({
    meta: { silenceToast: true },
    mutationFn: (keys: ImportKey[]) =>
      apiFetch<ImportSelectedResponse>('/api/keys/import-selected', {
        method: 'POST',
        body: JSON.stringify({ keys }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      // The dialog closes on success, so surface the imported/failed counts as
      // a toast.
      if (onImported) {
        toast.success(t('keys.importResult', { imported: data.imported, failed: data.errors.length }))
        onImported()
      }
    },
  })

  const selectedKeys: ImportKey[] = rows
    .filter(row => row.selected && row.platform && row.keyValue.trim())
    .map(row => ({
      keyName: row.keyName,
      keyValue: row.keyValue,
      platform: row.platform,
    }))

  function updateRow(index: number, patch: Partial<ImportRow>) {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function chooseFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(e.target.files ?? [])
    setFiles(nextFiles)
    setRows([])
    setSkipped([])
    preview.reset()
    importSelected.reset()
  }

  const previewButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => preview.mutate(files)}
      disabled={files.length === 0 || preview.isPending}
    >
      <Upload className="size-3.5" />
      {preview.isPending ? t('keys.previewing') : t('keys.previewFiles')}
    </Button>
  )

  const innerContent = (
    <>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1 space-y-1.5">
            <Label className="text-xs">{t('keys.importFiles')}</Label>
            <Input
              type="file"
              multiple
              accept=".env,.json,.jsonc,.md,.txt,.csv"
              onChange={chooseFiles}
              className="cursor-pointer text-xs file:mr-2"
            />
          </div>
          {files.length > 0 && (
            <span className="pb-1 text-xs text-muted-foreground">
              {t('keys.importFileCount', { count: files.length })}
            </span>
          )}
        </div>

        {preview.isError && (
          <p className="mt-3 text-xs text-destructive">{(preview.error as Error).message}</p>
        )}

        {rows.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">{t('keys.selected')}</TableHead>
                  <TableHead>{t('keys.provider')}</TableHead>
                  <TableHead>{t('keys.keyName')}</TableHead>
                  <TableHead>{t('keys.keyValue')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={`${row.keyName}:${index}`} className={row.isDuplicate ? 'bg-muted/50' : ''}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={row.selected}
                        disabled={row.isDuplicate}
                        onChange={() => updateRow(index, { selected: !row.selected })}
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.platform}
                        onValueChange={(value) => updateRow(index, { platform: value as Platform, selected: true })}
                      >
                        <SelectTrigger className="w-[190px]">
                          <SelectValue placeholder={t('keys.chooseProvider')} />
                        </SelectTrigger>
                        <SelectContent>
                          {importablePlatforms.map(p => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.keyName}
                          onChange={e => updateRow(index, { keyName: e.target.value })}
                          className="w-[220px] font-mono text-xs"
                        />
                        {row.isDuplicate && (
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            {t('keys.duplicate')}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-[280px] items-center gap-2">
                        <Input
                          type={row.visible ? 'text' : 'password'}
                          value={row.keyValue}
                          onChange={e => updateRow(index, { keyValue: e.target.value })}
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => updateRow(index, { visible: !row.visible })}
                        >
                          {row.visible ? t('common.hide') : t('common.show')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {rows.length === 0 && preview.isSuccess && (
          <p className="mt-3 text-xs text-muted-foreground">{t('keys.noPreviewKeys')}</p>
        )}

        {skipped.length > 0 && (
          <div className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t('keys.skippedItems')}</span>
            <span> {skipped.slice(0, 5).join(', ')}</span>
            {skipped.length > 5 && <span> {t('keys.moreItems', { count: skipped.length - 5 })}</span>}
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {rows.some(r => r.isDuplicate) && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t('keys.duplicatesFound', { count: rows.filter(r => r.isDuplicate).length })}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => importSelected.mutate(selectedKeys)}
              disabled={selectedKeys.length === 0 || importSelected.isPending}
            >
              {importSelected.isPending
                ? t('keys.importing')
                : t('keys.importSelected', { count: selectedKeys.length })}
            </Button>
            {selectedKeys.length === 0 && (
              <span className="text-xs text-muted-foreground">{t('keys.noImportSelection')}</span>
            )}
          </div>
        )}

        {importSelected.isError && (
          <p className="mt-3 text-xs text-destructive">{(importSelected.error as Error).message}</p>
        )}
    </>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('keys.importKeysDescription')}</p>
        {previewButton}
      </div>
      {innerContent}
    </div>
  )
}
