/**
 * `freellmapi copilot-login` — run the GitHub OAuth device flow and
 * persist the resulting `gho_...` token as a `github-copilot` key.
 *
 * Usage:
 *   npm run copilot-login -w server
 *   # or:
 *   npx tsx server/src/scripts/copilot-login.ts
 *
 * The script:
 *   1. Hits GitHub's device-code endpoint with opencode's client_id.
 *   2. Prints `user_code` + verification URL — the user opens the URL
 *      in any browser, enters the code, approves.
 *   3. Polls for the access token, then encrypts + inserts it into
 *      api_keys with platform='github-copilot'.
 *
 * Path B auth — the token persisted here is used directly as
 * `Authorization: Bearer ...` on `api.githubcopilot.com`. No token
 * exchange / refresh is performed; the GitHub OAuth token is long-lived.
 */
import { initDb, getDb } from '../db/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';
import { runDeviceFlow } from '../lib/copilot-auth.js';

async function main() {
  initDb();
  const db = getDb();

  console.log('\n=== freellmapi: GitHub Copilot login ===\n');
  console.log('This will run the GitHub OAuth device flow under opencode\'s client_id (Path B).');
  console.log('The resulting access token is stored as a `github-copilot` API key.\n');

  const accessToken = await runDeviceFlow(({ userCode, verificationUri, expiresIn }) => {
    const mins = Math.round(expiresIn / 60);
    console.log(`  1. Open ${verificationUri} in any browser`);
    console.log(`  2. Enter this code: ${userCode}`);
    console.log(`  3. Approve the request (expires in ${mins} minutes)\n`);
    console.log('Waiting for authorization...');
  });

  const label = `device-flow ${new Date().toISOString().slice(0, 10)}`;
  const { encrypted, iv, authTag } = encrypt(accessToken);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('github-copilot', ?, ?, ?, ?, 'unknown', 1)
  `).run(label, encrypted, iv, authTag);

  console.log(`\n✓ Token saved (api_keys.id = ${result.lastInsertRowid}, masked = ${maskKey(accessToken)}).`);
  console.log('  Platform: github-copilot');
  console.log('  Enabled : yes');
  console.log('  Models  : gpt-5-mini, gpt-5.4-mini, gpt-5.2-codex (seeded by migrateModelsV15)');
  console.log('\nRestart the freellmapi server so the in-memory router picks up the new key.\n');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\n✗ copilot-login failed:', err.message ?? err);
  process.exit(1);
});
