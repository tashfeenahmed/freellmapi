import { useState } from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { AddKeyForm } from './add-key-form'
import { ImportKeysSection } from './import-keys-section'
import { CustomProviderSection } from './custom-provider-section'

type Pane = 'provider' | 'import' | 'custom'

// The single "Add key" surface: one dialog, three panes (paste a provider key,
// import a file, or point at a custom OpenAI-compatible endpoint). Each pane
// keeps its own mutation and asks the dialog to close on success.
export function AddKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const [pane, setPane] = useState<Pane>('provider')
  const close = () => onOpenChange(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.addKey')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <SegmentedControl
          value={pane}
          onValueChange={setPane}
          options={[
            { value: 'provider', label: t('keys.paneProviderKey') },
            { value: 'import', label: t('keys.paneImportFile') },
            { value: 'custom', label: t('keys.paneCustomEndpoint') },
          ]}
          ariaLabel={t('keys.addKey')}
          className="mb-5"
        />

        {pane === 'provider' && <AddKeyForm onSuccess={close} />}
        {pane === 'import' && <ImportKeysSection onImported={close} />}
        {pane === 'custom' && <CustomProviderSection onAdded={close} />}
      </DialogPopup>
    </Dialog>
  )
}
