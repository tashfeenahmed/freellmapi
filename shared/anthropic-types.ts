// Anthropic Messages API types — mirrors the official protocol at
// https://docs.anthropic.com/en/api/messages
//
// These are intentionally defined here rather than re-exported from the
// @anthropic-ai/sdk package so we control the surface and avoid coupling to
// package-private module paths that aren't part of the public exports map.

// ---- Content Blocks (requests) ----

export interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: CacheControlEphemeral | null;
}

export interface ImageBlockParam {
  type: 'image';
  source: Base64ImageSource;
  cache_control?: CacheControlEphemeral | null;
}

export interface Base64ImageSource {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface ToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControlEphemeral | null;
}

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlockParam[];
  is_error?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam;

// ---- Content Blocks (responses) ----

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

// ---- Messages ----

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens?: number;
}

// ---- Tools ----

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  cache_control?: CacheControlEphemeral | null;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

// ---- Prompt caching ----

export interface CacheControlEphemeral {
  type: 'ephemeral';
}

// ---- Request ----

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessageParam[];
  system?: string | TextBlockParam[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
}

// ---- Provider options (internal) ----

export interface MessagesOptions {
  model: string;
  messages: AnthropicMessageParam[];
  system?: string | TextBlockParam[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
}

// ---- Streaming events ----

export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    content: [];
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: AnthropicUsage;
  };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'text';
    text: '';
  } | {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | InputJsonDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: StopReason | null;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface PingEvent {
  type: 'ping';
}

export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent;

// ---- Error ----

export interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}

export type AnthropicErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';
