import fs from 'node:fs';
import path from 'node:path';

// Client detection for the ChatGPT (formerly Codex) integration. `setup-codex`
// only WRITES a config; this module tells the user WHICH client they actually
// have so the setup note can say something true about their machine instead of
// a generic "install X" line. Purely filesystem/PATH based — no network, no
// spawning processes — so it stays fast and testable.

export interface DetectedClient {
  /** `cli` — the `codex` binary is on PATH; `desktop` — the ChatGPT desktop
   *  app is installed (macOS); `both` — self-explanatory. */
  kind: 'cli' | 'desktop' | 'both';
  /** Absolute path of the first `codex` binary found on PATH, when present. */
  cliPath?: string;
  /** Absolute path of the ChatGPT.app bundle, when present. */
  desktopPath?: string;
}

/** Where the ChatGPT desktop app lives per platform. Only macOS ships a
 *  well-known .app bundle; Windows/Linux register no stable path we can
 *  probe cheaply, so those return nothing (a UI integration there would need
 *  registry/freedesktop lookups — out of scope). */
export function desktopAppPath(platform: string = process.platform): string | undefined {
  if (platform !== 'darwin') return undefined;
  return '/Applications/ChatGPT.app';
}

function executableOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      // Directories on PATH shadow real binaries (a common nvm artifact);
      // only a regular file counts.
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep scanning.
    }
  }
  return undefined;
}

export function detectChatGptClient(
  platform: string = process.platform,
): DetectedClient | undefined {
  const cliPath = executableOnPath('codex');
  const appPath = desktopAppPath(platform);
  const hasDesktop = appPath !== undefined && fs.existsSync(appPath);
  if (cliPath && hasDesktop) return { kind: 'both', cliPath, desktopPath: appPath };
  if (cliPath) return { kind: 'cli', cliPath };
  if (hasDesktop) return { kind: 'desktop', desktopPath: appPath };
  return undefined;
}

/** Human-readable guidance appended to `setup-codex` output. The desktop app
 *  cannot point its API traffic at a custom gateway, so it is reported but
 *  never configured — the CLI is the only surface this gateway can serve. */
export function clientNotes(client: DetectedClient | undefined): string[] {
  if (!client) {
    return [
      'No ChatGPT (Codex) client detected on this machine.',
      'Install the CLI with: npm install -g @openai/codex',
    ];
  }
  if (client.kind === 'desktop') {
    return [
      `ChatGPT desktop app detected at ${client.desktopPath}; it does not support custom API gateways.`,
      'The generated configuration targets the Codex CLI — install it with: npm install -g @openai/codex',
    ];
  }
  if (client.kind === 'both') {
    return [
      `Codex CLI detected at ${client.cliPath}; the configuration above applies to it.`,
      'ChatGPT desktop app also detected; it does not support custom API gateways.',
    ];
  }
  return [`Codex CLI detected at ${client.cliPath}; the configuration above applies to it.`];
}
