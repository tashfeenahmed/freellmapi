import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TerminalAgent } from '../../shared/agent-setup.js';

export function findAgentExecutable(agent: TerminalAgent, home: string): string | undefined {
  const windows = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  if (agent === 'mimo') dirs.push(path.join(home, '.mimocode', 'bin'));
  if (windows) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    dirs.push(path.join(home, '.local', 'bin'), path.join(home, 'scoop', 'shims'));
  } else {
    dirs.push(path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin');
    // Apps started from Finder do not inherit the shell's nvm PATH.
    const versions = path.join(home, '.nvm/versions/node');
    if (fs.existsSync(versions)) {
      for (const version of fs.readdirSync(versions).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
        dirs.push(path.join(versions, version, 'bin'));
      }
    }
  }
  for (const dir of dirs) {
    for (const ext of windows ? ['.exe', '.cmd', '.bat'] : ['']) {
      const file = path.join(dir, agent + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch { /* Try the next executable directory. */ }
    }
  }
}

const shQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const run = promisify(execFile);
const openCommand = async (file: string) => { await run('/usr/bin/open', ['-b', 'com.apple.Terminal', file]); };

// LaunchServices cannot pass a new environment to an existing Terminal.app.
// Hand the key to just this command over a one-use socket in a 0700 directory.
// Neither the command file nor the process arguments contain the credential.
export async function launchMacTerminal(executable: string, key: string, open = openCommand): Promise<void> {
  const dir = fs.mkdtempSync('/tmp/freellmapi-');
  const socketPath = path.join(dir, 'session');
  const command = path.join(dir, 'FreeLLMAPI.command');
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.end(key);
    cleanup();
  });
  const cleanup = () => {
    clearTimeout(timer);
    if (server.listening) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const timer = setTimeout(cleanup, 60_000);
  timer.unref();
  try {
    fs.writeFileSync(command, [
      '#!/bin/sh',
      'cd "$HOME" || exit 1',
      'FREELLMAPI_API_KEY=$(/usr/bin/nc -d -U ' + shQuote(socketPath) + ') || exit 1',
      '[ -n "$FREELLMAPI_API_KEY" ] || exit 1',
      'export FREELLMAPI_API_KEY',
      'export PATH=' + shQuote(path.dirname(executable)) + ':"$PATH"',
      'exec ' + shQuote(executable),
      '',
    ].join('\n'), { mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await open(command);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function launchAgent(executable: string, key: string): Promise<void> {
  if (process.platform === 'darwin') return launchMacTerminal(executable, key);
  const powershell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Use an inherited environment and a constant command. Paths with spaces or
  // PowerShell metacharacters are passed as a value, never parsed as source.
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:FREELLMAPI_AGENT_EXE -WindowStyle Normal",
  ], {
    cwd: os.homedir(), windowsHide: true,
    env: { ...process.env, FREELLMAPI_API_KEY: key, FREELLMAPI_AGENT_EXE: executable },
  });
}
