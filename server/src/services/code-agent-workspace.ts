import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import zlib from 'zlib';
import { getDefaultDbPath } from '../db/index.js';

export interface FsEntry {
  name: string;
  path: string; // workspace-relative, posix
  type: 'file' | 'directory';
  size?: number;
}

function dataDir(): string {
  const db = process.env.FREEAPI_DB_PATH?.trim() || getDefaultDbPath();
  if (db === ':memory:') return path.resolve('/tmp/kilo');
  return path.dirname(path.resolve(db));
}

export function workspaceRoot(): string {
  const root = path.join(dataDir(), 'code-agent-workspace');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function normRel(input: string | undefined | null): string {
  const raw = (input ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw === '.' || raw === '/') return '';
  const cleaned = raw.replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '..') throw Object.assign(new Error('Invalid path'), { status: 400 });
  }
  return parts.join('/');
}

export function resolveSafe(rel?: string | null): { root: string; rel: string; abs: string } {
  const root = workspaceRoot();
  const relPath = normRel(rel);
  const abs = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw Object.assign(new Error('Path escapes workspace'), { status: 400 });
  }
  return { root, rel: relPath, abs };
}

export async function listDir(rel?: string | null): Promise<FsEntry[]> {
  const { rel: relPath, abs } = resolveSafe(rel);
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw Object.assign(new Error('Path not found'), { status: 404 });
  }
  if (!st.isDirectory()) throw Object.assign(new Error('Not a directory'), { status: 400 });
  const names = await fsp.readdir(abs);
  const entries: FsEntry[] = [];
  for (const name of names) {
    if (name === '.DS_Store') continue;
    const childAbs = path.join(abs, name);
    const childRel = relPath ? `${relPath}/${name}` : name;
    let cst: fs.Stats;
    try { cst = await fsp.lstat(childAbs); } catch { continue; }
    if (cst.isDirectory()) entries.push({ name, path: childRel, type: 'directory' });
    else if (cst.isFile()) entries.push({ name, path: childRel, type: 'file', size: cst.size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return entries;
}

export async function readFileText(rel: string): Promise<{ path: string; content: string; size: number }> {
  const { rel: relPath, abs } = resolveSafe(rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw Object.assign(new Error('File not found'), { status: 404 });
  if (st.size > 1024 * 1024) throw Object.assign(new Error('File too large to read (max 1MB)'), { status: 413 });
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) throw Object.assign(new Error('Binary file cannot be read as text'), { status: 415 });
  return { path: relPath, content: buf.toString('utf8'), size: st.size };
}

export async function writeFileText(rel: string, content: string): Promise<{ path: string }> {
  const { rel: relPath, abs } = resolveSafe(rel);
  if (!relPath) throw Object.assign(new Error('File path required'), { status: 400 });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content ?? '', 'utf8');
  return { path: relPath };
}

export async function makeDir(rel: string): Promise<{ path: string }> {
  const { rel: relPath, abs } = resolveSafe(rel);
  if (!relPath) throw Object.assign(new Error('Folder path required'), { status: 400 });
  await fsp.mkdir(abs, { recursive: true });
  return { path: relPath };
}

export async function deletePath(rel: string): Promise<{ path: string }> {
  const { rel: relPath, abs } = resolveSafe(rel);
  if (!relPath) throw Object.assign(new Error('Refusing to delete workspace root'), { status: 400 });
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) throw Object.assign(new Error('Path not found'), { status: 404 });
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: relPath };
}

export async function renamePath(fromRel: string, toRel: string): Promise<{ from: string; to: string }> {
  const from = resolveSafe(fromRel);
  const to = resolveSafe(toRel);
  if (!from.rel || !to.rel) throw Object.assign(new Error('Path required'), { status: 400 });
  await fsp.mkdir(path.dirname(to.abs), { recursive: true });
  await fsp.rename(from.abs, to.abs);
  return { from: from.rel, to: to.rel };
}

export async function buildTree(rel = ''): Promise<any> {
  const entries = await listDir(rel);
  const out: any[] = [];
  for (const e of entries) {
    if (e.type === 'directory') {
      out.push({ ...e, children: await buildTree(e.path) });
    } else {
      out.push(e);
    }
  }
  return out;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err || `${cmd} exited ${code}`)));
  });
}

export async function extractZipBuffer(buf: Buffer): Promise<void> {
  const root = workspaceRoot();
  const tmp = path.join(root, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await fsp.writeFile(tmp, buf);
  try {
    await run('unzip', ['-o', '-q', tmp, '-d', root]);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

// Minimal ZIP (store, no compression) for workspace download
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipDirectory(rel?: string | null): Promise<{ buffer: Buffer; filename: string }> {
  const { rel: relPath, abs } = resolveSafe(rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw Object.assign(new Error('Path not found'), { status: 404 });
  const baseName = relPath ? path.posix.basename(relPath) : 'workspace';

  const files: { name: string; data: Buffer }[] = [];
  async function walk(dirAbs: string, prefix: string) {
    const items = await fsp.readdir(dirAbs);
    for (const name of items) {
      const p = path.join(dirAbs, name);
      const relName = prefix ? `${prefix}/${name}` : name;
      const s = await fsp.lstat(p);
      if (s.isDirectory()) {
        files.push({ name: relName + '/', data: Buffer.alloc(0) });
        await walk(p, relName);
      } else if (s.isFile()) {
        if (s.size > 5 * 1024 * 1024) continue; // skip huge files
        files.push({ name: relName, data: await fsp.readFile(p) });
      }
    }
  }
  if (st.isDirectory()) await walk(abs, '');
  else if (st.isFile()) files.push({ name: path.posix.basename(relPath), data: await fsp.readFile(abs) });

  const { time, date } = dosDateTime();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const buffer = Buffer.concat([...localParts, ...centralParts, end]);
  return { buffer, filename: `${baseName || 'workspace'}.zip` };
}
