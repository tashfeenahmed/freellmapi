// Launcher: reads provider keys from env (injected by `infisical run`),
// builds FREEAPI_CONFIG_JSON in-memory, and starts the FreeLLMAPI server.
// Keys never touch disk or argv.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Load .env (ENCRYPTION_KEY, PORT) without a dep.
for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// Map Infisical secret names -> FreeLLMAPI platform slugs.
const MAP = {
  GROQ_API_KEY: 'groq',
  GOOGLE_AI_STUDIO_API_KEY: 'google',
  COHERE_API_KEY: 'cohere',
  CLOUDFLARE_API_TOKEN: 'cloudflare',
  HUGGINGFACE_API_TOKEN: 'huggingface',
  OPENROUTER_API_KEY: 'openrouter',
  CEREBRAS_API_KEY: 'cerebras',
};

const keys = [];
for (const [envName, platform] of Object.entries(MAP)) {
  const v = process.env[envName];
  if (v && v.trim()) keys.push({ platform, key: v.trim(), label: 'infisical', enabled: true });
}

console.log(`[launcher] seeding ${keys.length} provider keys: ${keys.map((k) => k.platform).join(', ')}`);
process.env.FREEAPI_CONFIG_JSON = JSON.stringify({ keys });

const child = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
