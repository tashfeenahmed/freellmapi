import { config } from './config.js';

// In-memory per-channel conversation history. Cleared on restart.
const store = new Map();

export function getHistory(channelId) {
  return store.get(channelId) ?? [];
}

export function addTurn(channelId, userContent, assistantContent) {
  if (config.historyLimit === 0) return;
  const history = [...getHistory(channelId), { role: 'user', content: userContent }, { role: 'assistant', content: assistantContent }];
  store.set(channelId, history.slice(-config.historyLimit));
}

export function resetHistory(channelId) {
  store.delete(channelId);
}
