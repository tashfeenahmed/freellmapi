import { Sparkles } from 'lucide-react'
import {
  siAnthropic, siBaidu, siDeepseek, siGooglegemini, siKimi, siMeta, siMinimax,
  siMistralai, siNvidia, siPerplexity, siQwen, type SimpleIcon,
} from 'simple-icons'
import { modelMakerOf, type ModelMakerId } from '@/lib/model-maker'

// The mark of the company that MADE a model, drawn at favicon size under a
// Playground reply. Path data comes from simple-icons (CC0); each mark stays
// the trademark of its owner and identifies the model's origin, nothing more.
// Makers we have no mark for — and ids we cannot place at all — get the same
// neutral default, so the line always carries one glyph in the same spot.
const MARKS: Partial<Record<ModelMakerId, SimpleIcon>> = {
  google: siGooglegemini,
  meta: siMeta,
  qwen: siQwen,
  deepseek: siDeepseek,
  mistral: siMistralai,
  anthropic: siAnthropic,
  nvidia: siNvidia,
  moonshot: siKimi,
  minimax: siMinimax,
  baidu: siBaidu,
  perplexity: siPerplexity,
}

export interface ModelMakerIconProps {
  modelId: string | null | undefined
  /** Who served it; goes in the tooltip so the host is one hover away. */
  platform?: string | null
  className?: string
}

export function ModelMakerIcon({ modelId, platform, className = 'size-3.5' }: ModelMakerIconProps) {
  const maker = modelMakerOf(modelId)
  const mark = maker ? MARKS[maker.id] : undefined
  const title = [maker?.name, platform ? `via ${platform}` : null].filter(Boolean).join(' · ') || platform || undefined
  if (!mark) {
    return (
      <span title={title} aria-label={title} className="inline-flex shrink-0 text-muted-foreground">
        <Sparkles className={className} aria-hidden="true" />
      </span>
    )
  }
  return (
    <span title={title} aria-label={title} className="inline-flex shrink-0" data-maker={maker!.id}>
      <svg viewBox="0 0 24 24" className={className} fill={`#${mark.hex}`} aria-hidden="true" focusable="false">
        <path d={mark.path} />
      </svg>
    </span>
  )
}
