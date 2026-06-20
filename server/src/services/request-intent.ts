import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from '../lib/content.js';

export interface RequestIntent {
  kind: 'agentic' | 'coding' | 'research' | 'chat' | 'general';
  coding: boolean;
  agentic: boolean;
  research: boolean;
  chat: boolean;
}

const CODING_TEXT_PATTERNS = [
  /\bclaude code\b/i,
  /\bcodex\b/i,
  /\bapply_patch\b/i,
  /\bstack trace\b/i,
  /\btraceback\b/i,
  /\brefactor\b/i,
  /\bdebug\b/i,
  /\bfix\b/i,
  /\bpatch\b/i,
  /\bdiff\b/i,
  /```/,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bpython\b/i,
  /\breact\b/i,
  /\bnext\.?js\b/i,
  /\bnode\.?js\b/i,
  /\bgit\b/i,
  /\bterminal\b/i,
  /\bshell\b/i,
  /\bworkspace\b/i,
  /\brepository\b/i,
];

const RESEARCH_TEXT_PATTERNS = [
  /\bresearch\b/i,
  /\banal(yze|ysis)\b/i,
  /\bcompare\b/i,
  /\bbenchmark\b/i,
  /\bdeep dive\b/i,
  /\bcitation\b/i,
  /\bsources?\b/i,
  /\bpaper\b/i,
  /\bliterature\b/i,
  /\bdataset\b/i,
  /\bproof\b/i,
  /\btheorem\b/i,
  /\breasoning\b/i,
  /\bdense\b/i,
  /\blong context\b/i,
  /\bcontext window\b/i,
  /\bsummarize\b/i,
  /\bsynthesize\b/i,
  /\binsight\b/i,
];

const CHAT_TEXT_PATTERNS = [
  /\bhi\b/i,
  /\bhello\b/i,
  /\bhey\b/i,
  /\bhow are you\b/i,
  /\bchitchat\b/i,
  /\bsmall talk\b/i,
  /\bcasual\b/i,
  /\bconversation\b/i,
  /\bfriendly\b/i,
  /\bpolite reply\b/i,
  /\bdraft a message\b/i,
  /\brewrite this message\b/i,
];

const AGENT_TOOL_NAMES = new Set([
  'apply_patch',
  'local_shell',
  'shell',
  'terminal',
  'bash',
  'exec',
  'read_file',
  'write_file',
  'edit_file',
  'replace_file',
  'filesystem',
  'file',
  'web_search',
]);

type ToolLike = { type?: string; name?: string; function?: { name?: string } };

function normalizeToolName(tool: ToolLike): string {
  return (tool.function?.name ?? tool.name ?? '').trim().toLowerCase();
}

function collectMessageText(messages: ChatMessage[]): string {
  return messages.map(m => contentToString(m.content)).join('\n\n');
}

export function detectRequestIntent(messages: ChatMessage[], tools?: ToolLike[]): RequestIntent {
  const text = collectMessageText(messages);
  const hasTools = (tools?.length ?? 0) > 0;
  const hasBuiltInTool = tools?.some(tool => tool.type != null && tool.type !== 'function') ?? false;
  const hasAgentToolName = tools?.some(tool => AGENT_TOOL_NAMES.has(normalizeToolName(tool))) ?? false;
  const hasCodingText = CODING_TEXT_PATTERNS.some(pattern => pattern.test(text));
  const hasResearchText = RESEARCH_TEXT_PATTERNS.some(pattern => pattern.test(text));
  const hasChatText = CHAT_TEXT_PATTERNS.some(pattern => pattern.test(text));
  const isShortChatty = !hasCodingText && !hasResearchText && text.trim().length > 0 && text.trim().length < 240;

  const coding = hasBuiltInTool || hasAgentToolName || hasCodingText;
  const agentic = hasTools || coding;
  const research = !coding && !agentic && hasResearchText;
  const chat = !coding && !agentic && (hasChatText || isShortChatty);
  const kind = coding
    ? (agentic ? 'agentic' : 'coding')
    : research
      ? 'research'
      : chat
        ? 'chat'
        : 'general';
  return {
    kind,
    coding,
    agentic,
    research,
    chat,
  };
}
