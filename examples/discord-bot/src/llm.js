import { config } from './config.js';

/**
 * Send a chat completion request to FreeLLMAPI (OpenAI-compatible).
 * @param {{role: string, content: string}[]} messages
 * @param {string} [model]
 * @returns {Promise<{text: string, model: string}>}
 */
export async function chat(messages, model = config.model) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: config.systemPrompt }, ...messages],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FreeLLMAPI returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return { text: text || '_(empty response)_', model: data?.model || model };
}

export async function listModels() {
  const res = await fetch(`${config.baseUrl}/models?execution_status=ready`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`FreeLLMAPI returned ${res.status}`);
  const data = await res.json();
  return (data?.data || []).map((m) => m.id);
}
