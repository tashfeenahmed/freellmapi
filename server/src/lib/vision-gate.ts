import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentHasImage } from './content.js';
import { visionModelAvailability } from '../services/router.js';

// Up-front gate for image requests (#118, #125, #2061, #2062).
//
// A request whose messages carry an image (in the latest turn OR anywhere in
// the re-sent history) can only be served by a vision-capable model. When no
// such model can be routed to, answer with a clear 422 `no_vision_model`
// instead of letting the router skip every text-only model and surface a 429
// "All models exhausted", which reads as a quota problem.

export interface ImagePlacement {
  /** Total image blocks across all messages. */
  images: number;
  /** True when at least one image sits in a turn before the last user turn. */
  inHistory: boolean;
  /** True when the last user turn itself carries an image. */
  inLatest: boolean;
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => {
    const type = (block as { type?: string })?.type;
    return type === 'image_url' || type === 'image';
  }).length;
}

export function imagePlacement(messages: ChatMessage[]): ImagePlacement {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  let images = 0;
  let inHistory = false;
  let inLatest = false;
  messages.forEach((m, i) => {
    if (!contentHasImage(m.content)) return;
    images += countImages(m.content);
    if (i === lastUser) inLatest = true;
    else inHistory = true;
  });
  return { images, inHistory, inLatest };
}

export function noVisionModelMessage(enabledInChain: number, placement?: ImagePlacement): string {
  const where = placement?.inHistory && !placement.inLatest
    ? 'an image in an earlier turn of the conversation history'
    : placement?.inHistory
      ? 'images in the latest message and in earlier conversation history'
      : 'an image';
  const reason = enabledInChain > 0
    ? `none of the ${enabledInChain} enabled vision-capable model${enabledInChain === 1 ? '' : 's'} has a usable API key. Add a key for a vision provider (e.g. Google for Gemini 2.5 Flash)`
    : 'no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain';
  return `This request includes ${where}, but ${reason}, or remove the image from the conversation.`;
}

export interface VisionBlockedLog {
  surface: string;
  stage: 'precheck' | 'routing';
  requestId?: string;
  placement?: ImagePlacement;
  messages?: number;
  enabledInChain?: number;
  routable?: number;
  candidates?: number;
}

/**
 * One structured line per blocked image request, so an operator can tell
 * "no vision model" from a quota problem in the server log (#2062). The event
 * is `history_vision_blocked` when the only images are in re-sent history,
 * `vision_blocked` otherwise.
 */
export function logVisionBlocked(info: VisionBlockedLog): void {
  const p = info.placement;
  const event = p && p.inHistory && !p.inLatest ? 'history_vision_blocked' : 'vision_blocked';
  const fields: string[] = [`event=${event}`, `stage=${info.stage}`, `surface="${info.surface}"`];
  if (info.requestId) fields.push(`req=${info.requestId.replace(/-/g, '').slice(0, 6)}`);
  if (p) fields.push(`images=${p.images}`, `image_in_history=${p.inHistory}`, `image_in_latest=${p.inLatest}`);
  if (info.messages != null) fields.push(`history_size=${info.messages}`);
  if (info.enabledInChain != null) fields.push(`vision_models_enabled=${info.enabledInChain}`);
  if (info.routable != null) fields.push(`vision_models_available=${info.routable}`);
  if (info.candidates != null) fields.push(`candidates=${info.candidates}`);
  console.warn(`[vision] ${fields.join(' ')} -> 422 no_vision_model`);
}

/**
 * Returns null when the request can go on to routing, or the 422 message to
 * send. Logs the blocked case.
 */
export function checkVisionCapacity(
  messages: ChatMessage[],
  surface: string,
  requestId?: string,
): string | null {
  const placement = imagePlacement(messages);
  if (placement.images === 0) return null;
  const { enabledInChain, routable } = visionModelAvailability();
  if (routable > 0) return null;
  logVisionBlocked({
    surface, stage: 'precheck', requestId, placement,
    messages: messages.length, enabledInChain, routable,
  });
  return noVisionModelMessage(enabledInChain, placement);
}
