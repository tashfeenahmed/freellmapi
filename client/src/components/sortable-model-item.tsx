import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { dragDots } from '@/components/model-table'

interface SortableModelItemProps {
  id: string            // unique sortable id (prefixed to avoid collisions)
  modelId: string       // the model_id value
  label: string
  platform: string
  providerCount: number
  onRemove: (modelId: string) => void
}

export function SortableModelItem({
  id,
  modelId,
  label,
  platform,
  providerCount,
  onRemove,
}: SortableModelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-3 py-2 bg-card border-b last:border-0 ${
        isDragging ? 'opacity-40 z-10' : ''
      }`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors shrink-0"
        aria-label="Drag to reorder"
      >
        {dragDots}
      </button>

      {/* Model info */}
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">{modelId}</span>
      </span>

      {/* Platform / provider badge */}
      <Badge variant="secondary" className="text-[10px] shrink-0">
        {providerCount > 1 ? `${providerCount} providers` : platform}
      </Badge>

      {/* Remove button */}
      <button
        type="button"
        onClick={() => onRemove(modelId)}
        className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
        aria-label={`Remove ${label}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
