// Who MADE a model, inferred from its id — as opposed to who is serving it
// (the platform). A Llama on Groq and the same Llama on Cloudflare are both
// Meta's; the Playground shows the maker's mark under a reply, and the host in
// the tooltip. Pure so it can be tested without React.

export type ModelMakerId =
  | 'google' | 'meta' | 'qwen' | 'deepseek' | 'mistral' | 'anthropic' | 'openai'
  | 'nvidia' | 'moonshot' | 'zhipu' | 'minimax' | 'baidu' | 'perplexity' | 'cohere'
  | 'microsoft' | 'xai' | 'tencent' | 'ibm' | 'ai21' | 'thinkingmachines'

export interface ModelMaker {
  id: ModelMakerId
  name: string
}

const MAKERS: Record<ModelMakerId, string> = {
  google: 'Google', meta: 'Meta', qwen: 'Qwen', deepseek: 'DeepSeek', mistral: 'Mistral AI',
  anthropic: 'Anthropic', openai: 'OpenAI', nvidia: 'NVIDIA', moonshot: 'Moonshot AI', zhipu: 'Zhipu AI',
  minimax: 'MiniMax', baidu: 'Baidu', perplexity: 'Perplexity', cohere: 'Cohere', microsoft: 'Microsoft',
  xai: 'xAI', tencent: 'Tencent', ibm: 'IBM', ai21: 'AI21 Labs', thinkingmachines: 'Thinking Machines',
}

// Ordered: the first family marker found in the id wins. Markers are matched on
// word boundaries in a lowercased id with the vendor prefix ("meta-llama/",
// "google/") stripped, so "gpt-oss" lands on OpenAI and "o3" is not found
// inside another word.
const FAMILIES: Array<[RegExp, ModelMakerId]> = [
  // Fine-tunes and distillations name their base too ("deepseek-r1-distill-
  // llama", "llama-3.1-nemotron"), so the derived brand is listed before the
  // base families it is built on.
  [/\bnemotron\b/, 'nvidia'],
  [/\bdeepseek\b/, 'deepseek'],
  [/\b(qwen|qwq|qvq)\b/, 'qwen'],
  [/\b(mistral|mixtral|codestral|magistral|devstral|ministral|pixtral|mathstral|voxtral)\b/, 'mistral'],
  [/\b(gemini|gemma|palm|bison|learnlm)\b/, 'google'],
  [/\b(llama|codellama)\b/, 'meta'],
  [/\bclaude\b/, 'anthropic'],
  // Matched after the letter/digit split below, so "o3-mini" reads "o 3 mini".
  [/\b(gpt|chatgpt|davinci|whisper|dall e|dalle)\b|\bo [134]\b/, 'openai'],
  [/\b(kimi|moonshot)\b/, 'moonshot'],
  [/\b(glm|chatglm|cogview|cogvideo)\b/, 'zhipu'],
  [/\b(minimax|abab|hailuo)\b/, 'minimax'],
  [/\bernie\b/, 'baidu'],
  [/\bsonar\b/, 'perplexity'],
  [/\b(command|aya|c4ai)\b/, 'cohere'],
  [/\b(phi|wizardlm|orca)\b/, 'microsoft'],
  [/\bgrok\b/, 'xai'],
  [/\b(hunyuan|hy)\b/, 'tencent'],
  [/\bgranite\b/, 'ibm'],
  [/\bjamba\b/, 'ai21'],
  [/\binkling\b/, 'thinkingmachines'],
]

// The org segment of a namespaced id ("meta-llama/…", "Qwen/…") is a strong
// signal on its own, and settles ids whose family word is unusual.
const ORGS: Array<[RegExp, ModelMakerId]> = [
  [/^(google|gemini)$/, 'google'],
  [/^(meta|meta-llama|facebook)$/, 'meta'],
  [/^qwen$/, 'qwen'],
  [/^deepseek(-ai)?$/, 'deepseek'],
  [/^mistralai$/, 'mistral'],
  [/^anthropic$/, 'anthropic'],
  [/^openai$/, 'openai'],
  [/^nvidia$/, 'nvidia'],
  [/^moonshotai$/, 'moonshot'],
  [/^(zai-org|thudm|zhipuai|zhipu)$/, 'zhipu'],
  [/^minimaxai$/, 'minimax'],
  [/^baidu$/, 'baidu'],
  [/^perplexity(-ai)?$/, 'perplexity'],
  [/^cohereforai$/, 'cohere'],
  [/^microsoft$/, 'microsoft'],
  [/^(x-ai|xai)$/, 'xai'],
  [/^tencent$/, 'tencent'],
  [/^ibm(-granite)?$/, 'ibm'],
  [/^ai21(labs)?$/, 'ai21'],
  [/^thinkingmachines$/, 'thinkingmachines'],
]

export function modelMakerOf(modelId: string | null | undefined): ModelMaker | null {
  if (!modelId) return null
  const lower = modelId.trim().toLowerCase()
  // "org/name[:tag]" — try the org first, then the name; a bare id is its own name.
  const slash = lower.indexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : ''
  const name = (slash > 0 ? lower.slice(slash + 1) : lower).replace(/:.*$/, '')
  // Word boundaries need separators between letters and digits too
  // ("llama3", "gemma2", "qwen3", "o3mini", "gpt4o").
  const words = name.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').replace(/[-_./]/g, ' ')
  for (const [re, id] of FAMILIES) if (re.test(words)) return { id, name: MAKERS[id] }
  if (org) for (const [re, id] of ORGS) if (re.test(org)) return { id, name: MAKERS[id] }
  return null
}
