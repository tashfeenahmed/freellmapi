import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CreateProfileModal } from './create-profile-modal'

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

interface ProfilesModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeProfileId: number | null
  onActivate: (profileId: number) => void
  localProfiles: Profile[] | null
  setLocalProfiles: (profiles: Profile[] | null) => void
}

/**
 * SortableProfileChip is a single profile item inside the profiles manager list.
 * It integrates with dnd-kit for vertical reordering, allows marking/unmarking
 * as favorite, editing metadata, and deletion (with safe inline confirmation).
 */
function ProfileChipUI({
  profile,
  activeProfileId,
  canDelete,
  onActivate,
  onEdit,
  onDelete,
  onReset,
  onToggleFavorite,
  isDragging,
  dragHandleProps,
  style,
  setNodeRef,
}: {
  profile: Profile
  activeProfileId: number | null
  canDelete: boolean
  onActivate: (id: number) => void
  onEdit: (profile: Profile) => void
  onDelete: (id: number) => void
  onReset: (id: number) => void
  onToggleFavorite: (id: number, current: boolean) => void
  isDragging?: boolean
  dragHandleProps?: Record<string, any>
  style?: React.CSSProperties
  setNodeRef?: (node: HTMLElement | null) => void
}) {
  const isActive = activeProfileId == profile.id
  const isBuiltin = profile.type === 'builtin' || profile.type === 'default'
  const isDefault = profile.type === 'default'
  const [showConfirm, setShowConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative flex items-center gap-3 w-full p-3 rounded-xl border transition-all duration-200 cursor-pointer select-none
        ${isDragging ? 'opacity-50 z-10 shadow-lg' : ''}
        ${isActive
          ? 'bg-muted/40 border-foreground/30 shadow-sm'
          : 'bg-card border-border hover:border-foreground/20 hover:shadow-sm'
        }`}
      onClick={() => onActivate(profile.id)}
    >
      {/* Drag handle */}
      {!isDefault && dragHandleProps ? (
        <button
          {...dragHandleProps}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-foreground/70 transition-colors p-1 -ml-1 rounded hover:bg-muted"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
          </svg>
        </button>
      ) : (
        <div className="w-5" />
      )}

      {/* Profile Icon / Color Indicator */}
      <div 
        className="flex items-center justify-center size-8 rounded-lg text-lg border shadow-sm"
        style={{
          backgroundColor: `${profile.color}15`,
          borderColor: `${profile.color}40`,
          color: profile.color,
        }}
      >
        {profile.emoji || '💬'}
      </div>

      {/* Profile Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate text-foreground">
            {profile.name}
          </span>
          {isBuiltin && (
            <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-normal uppercase tracking-wider scale-90 origin-left">
              Built-in
            </span>
          )}
        </div>
      </div>

      {/* Favorite Toggle Star */}
      {!isDefault ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite(profile.id, profile.is_favorite === 1)
          }}
          className={`p-1.5 rounded-lg hover:bg-muted transition-colors ${
            profile.is_favorite === 1
              ? 'text-yellow-500 hover:text-yellow-600'
              : 'text-muted-foreground/30 hover:text-muted-foreground/60'
          }`}
          title={profile.is_favorite === 1 ? 'Remove from favorites' : 'Add to favorites'}
        >
          {profile.is_favorite === 1 ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
          )}
        </button>
      ) : (
        <div className="w-8 h-8" />
      )}

      {/* Edit button */}
      {!isBuiltin && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onEdit(profile)
          }}
          className="text-muted-foreground/30 hover:text-foreground hover:bg-muted p-1.5 rounded-lg transition-colors"
          title="Edit profile"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
      )}

      {/* Reset button */}
      <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
        {showResetConfirm ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                onReset(profile.id)
                setShowResetConfirm(false)
              }}
              className="text-[10px] bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500 hover:text-white px-2 py-1 rounded font-medium transition-colors"
            >
              Reset
            </button>
            <button
              onClick={() => setShowResetConfirm(false)}
              className="text-[10px] bg-muted hover:bg-muted-foreground/10 px-2 py-1 rounded text-muted-foreground hover:text-foreground font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setShowResetConfirm(true)
              setShowConfirm(false)
            }}
            className="text-muted-foreground/30 hover:text-yellow-600 hover:bg-yellow-500/10 p-1.5 rounded-lg transition-colors"
            title="Reset profile"
            aria-label="Reset profile"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
      </div>

      {/* Delete button with safety inline confirmation */}
      {!isBuiltin && (
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          {showConfirm ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  onDelete(profile.id)
                  setShowConfirm(false)
                }}
                className="text-[10px] bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground px-2 py-1 rounded font-medium transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="text-[10px] bg-muted hover:bg-muted-foreground/10 px-2 py-1 rounded text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (canDelete) {
                  setShowConfirm(true)
                  setShowResetConfirm(false)
                }
              }}
              disabled={!canDelete}
              className={`p-1.5 rounded-lg transition-colors ${
                canDelete
                  ? 'text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10'
                  : 'text-muted-foreground/10 cursor-not-allowed'
              }`}
              title={canDelete ? 'Delete profile' : 'Cannot delete the only profile'}
              aria-label="Delete profile"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SortableProfileChip(props: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.profile.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <ProfileChipUI
      {...props}
      isDragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      setNodeRef={setNodeRef}
      style={style}
    />
  )
}

function StaticProfileChip(props: any) {
  return <ProfileChipUI {...props} />
}

/**
 * ProfilesModal provides the main container modal for viewing, reordering (via drag-and-drop),
 * activating, deleting, and editing custom models fallback profiles.
 */
export function ProfilesModal({
  open,
  onOpenChange,
  activeProfileId,
  onActivate,
  localProfiles,
  setLocalProfiles,
}: ProfilesModalProps) {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [profileToEdit, setProfileToEdit] = useState<Profile | null>(null)

  // Query to fetch the updated profiles list
  const { data: fetchedProfiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
    enabled: open,
  })

  // Prefer temporary local state when drag reordering to keep the drag animation lag-free
  const profiles = localProfiles ?? fetchedProfiles

  // Mutation to persist profile order changes to backend
  const reorderMutation = useMutation({
    mutationFn: (data: { id: number; sort_order: number }[]) =>
      Promise.all(
        data.map(({ id, sort_order }) =>
          apiFetch(`/api/profiles/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ sort_order }),
          })
        )
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      setLocalProfiles(null)
    },
  })

  // Mutation to delete a profile
  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      queryClient.invalidateQueries({ queryKey: ['profiles', 'active'] })
    },
  })

  const resetMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/profiles/${id}/reset`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      // The profile reset changes the active profile's settings on backend
      // if it was active. FallbackPage will re-fetch /api/profiles/active configs
    },
  })

  // Mutation to toggle favorite state
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ id, is_favorite }: { id: number; is_favorite: boolean }) =>
      apiFetch(`/api/profiles/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_favorite }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Handles drag reorder completion and fires off batch updates to the backend
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = profiles.findIndex((p) => p.id === active.id)
    const newIndex = profiles.findIndex((p) => p.id === over.id)
    const reordered = arrayMove(profiles, oldIndex, newIndex)

    // Update local state temporarily for snappy UI response
    setLocalProfiles(reordered)

    // Persist sort_order updates to backend
    const updates = reordered.map((p, i) => ({
      id: p.id,
      sort_order: i + 1,
    }))
    reorderMutation.mutate(updates)
  }

  function handleDelete(id: number) {
    deleteMutation.mutate(id, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['profiles'] })
        queryClient.invalidateQueries({ queryKey: ['profiles', 'active'] })
      },
    })
  }

  function handleReset(id: number) {
    resetMutation.mutate(id)
  }

  const defaultProfiles = profiles.filter(p => p.type === 'default')
  const draggableProfiles = profiles.filter(p => p.type !== 'default')

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/40 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[90vw] rounded-xl border bg-background p-5 shadow-lg data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[starting-style]:scale-90 data-[starting-style]:opacity-0 transition-all">
            <Dialog.Title className="text-lg font-semibold mb-1">
              Manage Profiles
            </Dialog.Title>
            <p className="text-xs text-muted-foreground mb-4">
              Drag to reorder. Click on a profile to activate it.
            </p>

            <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto pr-1">
              {/* Create new profile button */}
              <button
                onClick={() => {
                  setProfileToEdit(null)
                  setShowCreate(true)
                }}
                className="flex items-center gap-3 w-full p-3 rounded-xl border border-dashed border-muted-foreground/30 hover:border-foreground/40 hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-all duration-200 select-none text-left"
              >
                <div className="flex items-center justify-center size-8 rounded-lg bg-muted text-muted-foreground/60 border border-muted-foreground/10">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div className="flex-1">
                  <span className="text-sm font-semibold">Create new profile</span>
                </div>
              </button>

              {/* Profile tiles */}
              <div className="flex flex-col gap-2 w-full">
                {defaultProfiles.map((profile) => (
                  <StaticProfileChip
                    key={profile.id}
                    profile={profile}
                    activeProfileId={activeProfileId}
                    canDelete={false}
                    onActivate={(id: number) => {
                      onActivate(id)
                      onOpenChange(false)
                    }}
                    onEdit={() => {}}
                    onDelete={() => {}}
                    onReset={handleReset}
                    onToggleFavorite={() => {}}
                  />
                ))}

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={draggableProfiles.map((p) => p.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {draggableProfiles.map((profile) => (
                      <SortableProfileChip
                        key={profile.id}
                        profile={profile}
                        activeProfileId={activeProfileId}
                        canDelete={profiles.length > 1}
                        onActivate={(id: number) => {
                          onActivate(id)
                          onOpenChange(false)
                        }}
                        onEdit={(p: Profile) => {
                          setProfileToEdit(p)
                          setShowCreate(true)
                        }}
                        onDelete={handleDelete}
                        onReset={handleReset}
                        onToggleFavorite={(id: number, current: boolean) => {
                          toggleFavoriteMutation.mutate({ id, is_favorite: !current })
                        }}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            </div>

            <div className="flex items-center justify-end mt-4 pt-3 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <CreateProfileModal
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open)
          if (!open) {
            setProfileToEdit(null)
          }
        }}
        activeProfileId={activeProfileId}
        profileToEdit={profileToEdit}
      />
    </>
  )
}