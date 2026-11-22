import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { app, BrowserWindow } from 'electron';
import catalog from '../../client/src/data/agent-tools.json';
import { registerAgentSetup } from '../src/agent-setup.js';
import { launchMacTerminal } from '../src/agent-terminal.js';
import { isTerminalAgent } from '../../shared/agent-setup.js';

const home = process.env.AGENT_TEST_HOME!;
const port = Number(process.env.AGENT_TEST_PORT);
const origin = 'http://127.0.0.1:' + port;
const key = process.env.AGENT_TEST_KEY!;
assert.ok(home && path.isAbsolute(home));
app.setPath('userData', path.join(home, 'electron'));
app.disableHardwareAcceleration();
async function smoke() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    preload: process.env.AGENT_TEST_PRELOAD!, sandbox: false, contextIsolation: true,
    additionalArguments: ['--freeapi-token=' + process.env.AGENT_TEST_TOKEN],
  } });
  // Run the generated .command file and its credential handoff without leaving
  // Terminal windows on a developer's Mac. CI exercises Terminal.app itself.
  const launch = process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true'
    ? (executable: string, apiKey: string) => launchMacTerminal(executable, apiKey, async command => {
      await promisify(execFile)(command, { timeout: 15_000 });
    })
    : undefined;
  registerAgentSetup({ port: () => port, key: () => key, dashboard: () => window, home, launch });
  const js = (script: string) => window.webContents.executeJavaScript(script);
  const wait = async (test: () => Promise<unknown> | unknown, message: string) => {
    const until = Date.now() + 15_000;
    do { if (await test()) return; await delay(80); } while (Date.now() < until);
    throw new Error(message);
  };
  const click = (selector: string) => js('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const textAt = (selector: string) => js('document.querySelector(' + JSON.stringify(selector) + ')?.textContent');
  await window.loadURL(origin + '/agents');
  await wait(() => textAt('[data-agent=claude] .connect'), 'desktop agent cards did not render');
  const cardCount = () => js('document.querySelectorAll("[data-agent]").length');
  assert.equal(await cardCount(), catalog.length);
  await js('document.querySelector("input[type=search]").focus()');
  await window.webContents.insertText('hermes');
  await wait(async () => await cardCount() === 1 && !!await textAt('[data-agent=hermes] h3'), 'search did not find Hermes');
  window.webContents.selectAll();
  window.webContents.delete();
  await wait(async () => await cardCount() === catalog.length, 'clearing search did not restore the full catalog');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const claude = path.join(home, '.claude/settings.json');
  fs.writeFileSync(claude, '{"unrelated":"keep"}');
  for (const tool of catalog) {
    const card = '[data-agent=' + tool.id + ']';
    await click(card + ' .more');
    await wait(() => textAt(card + ' .detail .value'), tool.id + ' setup details missing');
    const files: string[] = await js('Array.from(document.querySelectorAll(' + JSON.stringify(card + ' li > code') + '), el => el.textContent)');
    assert.ok(files.every(file => file.startsWith(home + path.sep)), 'destination outside test home: ' + tool.id);
    assert.equal(files.length === 0, tool.configType === 'guide');
    await click(card + ' .connect');
    if (tool.id === 'zcode') {
      await wait(async () => (await textAt(card + ' .detail'))?.includes('Quit ZCode'), 'ZCode quit guard');
      assert.ok(!fs.existsSync(files[0]));
      await click(card + ' .connect');
    }
    if (tool.configType === 'guide') {
      await wait(() => textAt(card + ' .key-field'), tool.id + ' guide missing');
      assert.ok(!(await textAt(card + ' .detail')).includes(key));
      assert.ok((await textAt(card + ' .detail')).includes(tool.id === 'cursor' ? 'https://<public-gateway>/v1' : origin + '/v1'));
      await click(card + ' .key-field .subbutton');
      await wait(async () => (await textAt(card + ' .key-field code')) === key, tool.id + ' key reveal failed');
    } else {
      await wait(async () => (await textAt(card + ' h4')) === 'Configuration saved', tool.id + ' did not save');
      const content = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
      assert.ok(content.includes(origin), tool.id + ' gateway URL missing');
      assert.ok(content.includes(isTerminalAgent(tool.id) ? 'FREELLMAPI_API_KEY' : key), tool.id + ' credential missing');
      assert.ok(!isTerminalAgent(tool.id) || !content.includes(key));
      if (tool.id === 'hermes' && process.platform === 'win32') assert.equal(files[0], path.join(process.env.LOCALAPPDATA!, 'hermes', 'config.yaml'));
      if (tool.id === 'goose' && process.platform === 'win32') assert.ok(files[0].includes(path.join('Block', 'goose', 'config')));
      if (tool.id === 'roo') assert.ok((await textAt(card + ' .detail')).includes('Import'));
      if (tool.id === 'openclaw' || tool.id === 'hermes') assert.ok((await textAt(card + ' .detail')).includes('Restart'));
      if (isTerminalAgent(tool.id)) {
        await click(card + ' .detail button.subbutton');
        const receipt = path.join(home, tool.id + '.result');
        await wait(() => fs.existsSync(receipt), tool.id + ' terminal never reached the gateway');
        assert.equal(fs.readFileSync(receipt, 'utf8'), '200');
      }
      // Re-running the real IPC action must be a no-op on every file.
      const again = await js('window.__FREEAPI_AGENT_SETUP__.connect(' + JSON.stringify(tool.id) + ')');
      assert.ok(again.ok && again.files.every((file: { changed: boolean }) => !file.changed), tool.id + ' was not idempotent');
    }
    console.log('[agent setup] passed ' + tool.name);
  }
  assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).unrelated, 'keep');
  const backups = fs.readdirSync(path.dirname(claude)).filter(n => n.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(claude), backups[0]), 'utf8'), '{"unrelated":"keep"}');
  fs.writeFileSync(claude, '{broken');
  const failed = await js("window.__FREEAPI_AGENT_SETUP__.connect('claude')");
  assert.equal(failed.error, 'config');
  assert.equal(fs.readFileSync(claude, 'utf8'), '{broken');
  await assert.rejects(js("window.__FREEAPI_AGENT_SETUP__.connect('../elsewhere')"));
  await window.loadURL(origin + '/agents?source=test');
  await js("history.replaceState({}, '', '/models/chat')");
  await assert.rejects(js("window.__FREEAPI_AGENT_SETUP__.connect('claude')"));
  console.log('[agent setup] passed all 21 agents, backups, retries and dashboard restrictions');
  app.exit(0);
}

void smoke().catch(err => { console.error(err); app.exit(1); });
