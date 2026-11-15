function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: process.env.DISCORD_GUILD_ID || null,
  baseUrl: (process.env.FREELLMAPI_BASE_URL || 'http://localhost:3001/v1').replace(/\/+$/, ''),
  apiKey: required('FREELLMAPI_KEY'),
  model: process.env.FREELLMAPI_MODEL || 'auto',
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    'You are a friendly, concise assistant in a Discord server. Use Discord markdown.',
  historyLimit: Math.max(0, Number.parseInt(process.env.HISTORY_LIMIT ?? '20', 10) || 0),
  autoReplyChannels: new Set(
    (process.env.AUTO_REPLY_CHANNELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
};
