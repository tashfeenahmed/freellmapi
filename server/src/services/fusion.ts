import { z } from 'zod';
import { routeRequest } from './router.js';
import type { ChatMessage, ChatCompletionResponse } from '@freellmapi/shared/types.js';

export const FUSION_MODEL_ID = 'fusion';
export const fusionConfigSchema = z.object({}).passthrough();

export class FusionError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function isFusionModel(modelId?: string | null): boolean {
  return (modelId ?? '').toLowerCase() === FUSION_MODEL_ID;
}

export async function runFusion(opts: {
  messages: ChatMessage[];
  config: unknown;
  options: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  };
  estimatedTokens: number;
  hooks?: {
    onPanel?: (payload: Record<string, unknown>) => void;
    onJudge?: (payload: Record<string, unknown>) => void;
    onJudgeDelta?: (delta: string) => void;
  };
}): Promise<{ response: ChatCompletionResponse; routedVia: string }> {
  const route = routeRequest(opts.estimatedTokens);
  const response = await route.provider.chatCompletion(route.apiKey, opts.messages, route.modelId, opts.options);
  return { response, routedVia: `${route.platform}/${route.modelId}` };
}
