export const AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';

export const AGNES_TEXT_MODEL = 'agnes-2.0-flash';
export const AGNES_IMAGE_MODEL = 'agnes-image-2.0-flash';
export const AGNES_VIDEO_MODEL = 'agnes-video-v2.0';

const AGNES_VIDEO_MODEL_ALIASES = new Set([
  AGNES_VIDEO_MODEL,
  'agnes-video-2.0',
]);

export function normalizeAgnesImageModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  return normalized === AGNES_IMAGE_MODEL ? AGNES_IMAGE_MODEL : null;
}

export function normalizeAgnesVideoModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  return AGNES_VIDEO_MODEL_ALIASES.has(normalized) ? AGNES_VIDEO_MODEL : null;
}
