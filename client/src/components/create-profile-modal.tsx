import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { apiFetch } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Smile, Palette } from 'lucide-react'

// Harmonic preset colors for styling profile themes
const PRESET_COLORS = [
  '#6366f1', // Indigo
  '#3b82f6', // Blue
  '#0ea5e9', // Sky
  '#06b6d4', // Cyan
  '#14b8a6', // Teal
  '#10b981', // Emerald
  '#22c55e', // Green
  '#84cc16', // Lime
  '#eab308', // Yellow
  '#f59e0b', // Amber
  '#f97316', // Orange
  '#ef4444', // Red
  '#ec4899', // Pink
  '#f43f5e', // Rose
  '#9333ea', // Purple
]

// Preset emojis for profile identity decoration
const PRESET_EMOJIS = [
  '💬', // Chat
  '🧠', // Brain
  '⚡', // Speed
  '🛠️', // Tools
  '🚀', // Rocket
  '🎨', // Art
  '📝', // Note
  '🔍', // Search
  '🤖', // Robot
  '💡', // Idea
  '⚙️', // Gear
  '💼', // Briefcase
  '💎', // Gem
  '🔮', // Crystal Ball
  '🗺️', // Map
]

interface Profile {
  id: number
  name: string
  emoji: string
  color: string
  type: string
  is_favorite: number
  sort_order: number
  layout_config?: string | null
}

interface CreateProfileModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeProfileId: number | null
  profileToEdit?: Profile | null
}

/**
 * CreateProfileModal handles the creation and editing of model fallback profiles.
 * It provides custom color picking, emoji decoration, and automatically initializes
 * the new profile with the fallback model order copied from the currently active profile.
 */
export function CreateProfileModal({
  open,
  onOpenChange,
  activeProfileId,
  profileToEdit = null,
}: CreateProfileModalProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [color, setColor] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const [copyCurrent, setCopyCurrent] = useState(false)

  // Reset fields or populate them with edited profile values on open/change
  useEffect(() => {
    if (open) {
      if (profileToEdit) {
        setName(profileToEdit.name)
        setEmoji(profileToEdit.emoji || '')
        setColor(profileToEdit.color || '')
      } else {
        setName('')
        setEmoji('')
        setColor('')
        setCopyCurrent(false)
      }
      setEmojiOpen(false)
      setColorOpen(false)
    }
  }, [open, profileToEdit])

  // Mutation to either create (POST) or update (PUT) the profile metadata
  const mutation = useMutation({
    mutationFn: (data: { name: string; emoji: string; color: string; sourceProfileId?: number }) => {
      if (profileToEdit) {
        return apiFetch(`/api/profiles/${profileToEdit.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: data.name,
            emoji: data.emoji,
            color: data.color,
          }),
        })
      } else {
        return apiFetch('/api/profiles', {
          method: 'POST',
          body: JSON.stringify(data),
        })
      }
    },
    onSuccess: () => {
      // Invalidate profiles query to refresh UI state immediately
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      setName('')
      setEmoji('')
      setColor('')
      onOpenChange(false)
    },
  })

  // Handles profile submission, attaching the current active profile ID to copy model priorities if creating
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const payload: { name: string; emoji: string; color: string; sourceProfileId?: number } = {
      name: name.trim(),
      emoji: emoji.trim(),
      color,
    }
    if (!profileToEdit && copyCurrent && activeProfileId) {
      payload.sourceProfileId = activeProfileId
    }
    mutation.mutate(payload)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/45 backdrop-blur-[1px] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity z-50" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] rounded-xl border bg-background p-5 shadow-xl data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 transition-all z-50">
          
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-sm font-semibold">
              {profileToEdit ? 'Edit profile' : 'Create profile'}
            </Dialog.Title>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground hover:text-foreground transition-colors size-6 flex items-center justify-center rounded-md hover:bg-muted"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="flex items-center gap-2">
              
              {/* Emoji Popover Button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setEmojiOpen(!emojiOpen)
                    setColorOpen(false)
                  }}
                  className={`size-9 flex items-center justify-center rounded-lg border bg-card hover:bg-muted text-lg shadow-sm transition-all active:scale-95 ${
                    emojiOpen ? 'border-foreground ring-1 ring-ring' : ''
                  }`}
                  title="Select emoji"
                >
                  {emoji || <Smile className="size-5 text-muted-foreground" />}
                </button>
                {emojiOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setEmojiOpen(false)} />
                    <div className="absolute top-full left-0 mt-2 p-1.5 bg-popover border rounded-xl shadow-lg z-50 grid grid-cols-4 gap-1 w-[136px] animate-in fade-in slide-in-from-top-1 duration-200">
                      <button
                        type="button"
                        onClick={() => {
                          setEmoji('')
                          setEmojiOpen(false)
                        }}
                        className={`size-7 flex items-center justify-center rounded-md border text-xs transition-all ${
                          emoji === ''
                            ? 'border-foreground bg-muted font-bold'
                            : 'border-transparent hover:bg-muted/50'
                        }`}
                        title="No emoji"
                      >
                        🚫
                      </button>
                      {PRESET_EMOJIS.map((e) => (
                        <button
                          key={e}
                          type="button"
                          onClick={() => {
                            setEmoji(e)
                            setEmojiOpen(false)
                          }}
                          className={`size-7 flex items-center justify-center rounded-md border text-base transition-all hover:scale-105 active:scale-95 ${
                            emoji === e
                              ? 'border-foreground bg-muted'
                              : 'border-transparent hover:bg-muted/50'
                          }`}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Color Popover Button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setColorOpen(!colorOpen)
                    setEmojiOpen(false)
                  }}
                  className={`size-9 flex items-center justify-center rounded-lg border bg-card hover:bg-muted shadow-sm transition-all active:scale-95 ${
                    colorOpen ? 'border-foreground ring-1 ring-ring' : ''
                  }`}
                  title="Select color"
                >
                  {color ? (
                    <span className="size-5 rounded-full border shadow-inner block" style={{ backgroundColor: color }} />
                  ) : (
                    <Palette className="size-5 text-muted-foreground" />
                  )}
                </button>
                {colorOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setColorOpen(false)} />
                    <div className="absolute top-full left-0 mt-2 p-1.5 bg-popover border rounded-xl shadow-lg z-50 grid grid-cols-4 gap-1 w-[136px] animate-in fade-in slide-in-from-top-1 duration-200">
                      <button
                        type="button"
                        onClick={() => {
                          setColor('')
                          setColorOpen(false)
                        }}
                        className={`size-7 flex items-center justify-center rounded-md border text-xs transition-all ${
                          color === ''
                            ? 'border-foreground bg-muted font-bold'
                            : 'border-transparent hover:bg-muted/50'
                        }`}
                        title="No color"
                      >
                        🚫
                      </button>
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => {
                            setColor(c)
                            setColorOpen(false)
                          }}
                          className={`size-7 rounded-md border transition-all hover:scale-105 active:scale-95 ${
                            color === c
                              ? 'border-foreground shadow-sm ring-2 ring-foreground/20'
                              : 'border-transparent'
                          }`}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Title Input */}
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 20))}
                placeholder="Profile name"
                className="flex-1"
                maxLength={20}
                autoFocus
              />

              {/* Submit Button */}
              <Button
                size="sm"
                type="submit"
                disabled={!name.trim() || mutation.isPending}
                className="shrink-0 h-9 px-4"
              >
                {mutation.isPending
                  ? '...'
                  : profileToEdit
                  ? 'Save'
                  : 'Create'}
              </Button>

            </div>

            {!profileToEdit && (
              <div className="flex items-center space-x-2 pt-1 pl-1">
                <Switch
                  id="copy-profile"
                  checked={copyCurrent}
                  onCheckedChange={setCopyCurrent}
                />
                <Label htmlFor="copy-profile" className="text-xs text-muted-foreground font-normal cursor-pointer">
                  Copy configuration from active profile {!activeProfileId && '(Default)'}
                </Label>
              </div>
            )}
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}