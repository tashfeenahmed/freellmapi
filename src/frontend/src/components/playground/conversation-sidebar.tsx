import { useEffect, useRef, useState } from 'react'
import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { relativeTime, type ConversationSummary } from '@/lib/playground-conversations'
import { useI18n } from '@/i18n'

// The Playground's saved-conversation rail. Collapses to a narrow strip (the
// toggle and "new chat" stay reachable) so a long transcript can have the whole
// width when you want it; the open/closed choice is remembered by the page.
//
// Open and collapsed are the same box at two widths. The container animates its
// width and clips; both layers inside keep a FIXED width and are laid over each
// other, so nothing reflows or squishes while the rail moves. Whichever layer is
// not in use fades out and ends `invisible`, which also takes it out of the tab
// order and the accessibility tree. A reader who asked for less motion gets the
// old instant snap.
//
// Deliberately dumb: every mutation is handed up to PlaygroundPage, which owns
// the active conversation, the transcript, and the saving. All this does is
// list, select, rename in place, and confirm a delete.

// Both layers sit on top of each other inside the animated container; only the
// width and the fade differ.
const LAYER =
  'absolute inset-y-0 start-0 flex flex-col transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

export function ConversationSidebar({
  conversations,
  activeId,
  open,
  onToggle,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[]
  activeId: number | null
  open: boolean
  onToggle: () => void
  onNew: () => void
  onSelect: (id: number) => void
  onRename: (id: number, title: string) => void
  onDelete: (id: number) => void
}) {
  const { t } = useI18n()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  // Re-render once a minute so "2m ago" doesn't quietly go stale while a long
  // answer streams.
  const [, setTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setTick(n => n + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.select()
  }, [renamingId])

  const startRename = (conversation: ConversationSummary) => {
    setRenamingId(conversation.id)
    setDraft(conversation.title)
  }

  const commitRename = () => {
    if (renamingId === null) return
    const title = draft.trim()
    const previous = conversations.find(c => c.id === renamingId)
    setRenamingId(null)
    // An empty box is a cancel, not a request for a nameless conversation.
    if (title && title !== previous?.title) onRename(renamingId, title)
  }

  return (
    <div
      className={`relative shrink-0 overflow-hidden border-e bg-card transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'w-60' : 'w-11'
      }`}
    >
      <div
        className={`${LAYER} w-11 items-center gap-1 py-3 ${
          open ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label={t('playgroundSessions.showSidebar')}
          title={t('playgroundSessions.showSidebar')}
        >
          <PanelLeftOpen className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNew}
          aria-label={t('playgroundSessions.newConversation')}
          title={t('playgroundSessions.newConversation')}
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      </div>

      <div
        className={`${LAYER} w-60 ${open ? 'visible opacity-100' : 'invisible opacity-0'}`}
      >
        <div className="flex shrink-0 items-center gap-1 border-b px-2.5 py-2">
          <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
            {t('playgroundSessions.heading')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNew}
            aria-label={t('playgroundSessions.newConversation')}
            title={t('playgroundSessions.newConversation')}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            aria-label={t('playgroundSessions.hideSidebar')}
            title={t('playgroundSessions.hideSidebar')}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t('playgroundSessions.empty')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map(conversation => {
                const isActive = conversation.id === activeId
                const when = relativeTime(conversation.updatedAt)
                return (
                  <li key={conversation.id}>
                    {renamingId === conversation.id ? (
                      <input
                        ref={renameRef}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                          if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                        }}
                        aria-label={t('playgroundSessions.renamePlaceholder')}
                        placeholder={t('playgroundSessions.renamePlaceholder')}
                        className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                      />
                    ) : (
                      <div
                        className={`group flex items-center gap-0.5 rounded-lg pr-0.5 transition-colors ${
                          isActive ? 'bg-muted' : 'hover:bg-muted/60'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(conversation.id)}
                          onDoubleClick={() => startRename(conversation)}
                          className="min-w-0 flex-1 px-2 py-1.5 text-left"
                        >
                          <span className="block truncate text-sm">
                            {conversation.title || t('playgroundSessions.untitled')}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground tabular-nums">
                            {t(`playgroundSessions.${when.key}`, { count: when.count })}
                            {' · '}
                            {t('playgroundSessions.messageCount', { count: conversation.messageCount })}
                          </span>
                        </button>
                        {/* Row actions stay out of the way until the row is
                            hovered or focused, so the list reads as titles. */}
                        <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => startRename(conversation)}
                            aria-label={t('playgroundSessions.rename')}
                            title={t('playgroundSessions.rename')}
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <ConfirmButton
                            size="icon-xs"
                            armedSize="xs"
                            onConfirm={() => onDelete(conversation.id)}
                            aria-label={t('common.delete')}
                            title={t('common.delete')}
                          >
                            <Trash2 className="size-3" />
                          </ConfirmButton>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
