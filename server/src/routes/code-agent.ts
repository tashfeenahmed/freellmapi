import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  buildTree,
  deletePath,
  extractZipBuffer,
  listDir,
  makeDir,
  readFileText,
  renamePath,
  writeFileText,
  zipDirectory,
  workspaceRoot,
} from '../services/code-agent-workspace.js';

export const codeAgentRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function err(res: Response, e: unknown) {
  const status = (e as any)?.status || 500;
  const message = e instanceof Error ? e.message : 'Request failed';
  res.status(status).json({ error: { message } });
}

codeAgentRouter.get('/tree', async (req: Request, res: Response) => {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    res.json({ root: workspaceRoot(), path: p, entries: await buildTree(p) });
  } catch (e) { err(res, e); }
});

codeAgentRouter.get('/list', async (req: Request, res: Response) => {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    res.json({ path: p, entries: await listDir(p) });
  } catch (e) { err(res, e); }
});

codeAgentRouter.get('/file', async (req: Request, res: Response) => {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) { res.status(400).json({ error: { message: 'path is required' } }); return; }
    res.json(await readFileText(p));
  } catch (e) { err(res, e); }
});

const writeSchema = z.object({ path: z.string().min(1), content: z.string().default('') });
codeAgentRouter.put('/file', async (req: Request, res: Response) => {
  try {
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid body' } }); return; }
    res.json(await writeFileText(parsed.data.path, parsed.data.content));
  } catch (e) { err(res, e); }
});

const mkdirSchema = z.object({ path: z.string().min(1) });
codeAgentRouter.post('/mkdir', async (req: Request, res: Response) => {
  try {
    const parsed = mkdirSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid body' } }); return; }
    res.json(await makeDir(parsed.data.path));
  } catch (e) { err(res, e); }
});

codeAgentRouter.delete('/path', async (req: Request, res: Response) => {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) { res.status(400).json({ error: { message: 'path is required' } }); return; }
    res.json(await deletePath(p));
  } catch (e) { err(res, e); }
});

const renameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
codeAgentRouter.post('/rename', async (req: Request, res: Response) => {
  try {
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid body' } }); return; }
    res.json(await renamePath(parsed.data.from, parsed.data.to));
  } catch (e) { err(res, e); }
});

codeAgentRouter.post('/upload-zip', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) { res.status(400).json({ error: { message: 'Zip file is required' } }); return; }
    await extractZipBuffer(file.buffer);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

codeAgentRouter.get('/download-zip', async (req: Request, res: Response) => {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const { buffer, filename } = await zipDirectory(p || undefined);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) { err(res, e); }
});

const chatSchema = z.object({
  messages: z.array(z.any()).min(1),
  model: z.string().optional(),
});

const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List files and folders in the workspace or a directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to workspace root. Empty for root.' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace root.' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'make_folder', description: 'Create a folder (and parents).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'delete_path', description: 'Delete a file or folder.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'rename_path', description: 'Rename or move a file/folder.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
];

async function runTool(name: string, args: any): Promise<string> {
  try {
    if (name === 'list_files') return JSON.stringify(await listDir(args?.path || ''));
    if (name === 'read_file') return JSON.stringify(await readFileText(args.path));
    if (name === 'write_file') return JSON.stringify(await writeFileText(args.path, args.content ?? ''));
    if (name === 'make_folder') return JSON.stringify(await makeDir(args.path));
    if (name === 'delete_path') return JSON.stringify(await deletePath(args.path));
    if (name === 'rename_path') return JSON.stringify(await renamePath(args.from, args.to));
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (e: any) {
    return JSON.stringify({ error: e?.message || String(e) });
  }
}

codeAgentRouter.post('/chat', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid body' } }); return; }
  const { getUnifiedApiKey } = await import('../db/index.js');
  const apiKey = getUnifiedApiKey();
  const base = `http://127.0.0.1:${(req.socket.localPort || 18787)}`;
  const system = { role: 'system', content: 'You are a code agent working in an isolated workspace. Use the provided tools to list, read, write, create, rename, and delete files/folders as requested. Prefer minimal, correct changes. After completing actions, summarize what you changed.' };
  let messages: any[] = [system, ...parsed.data.messages];
  const model = parsed.data.model || 'auto';
  const steps: any[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto' }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json({ error: data.error || { message: 'Agent request failed' }, steps });
      return;
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) { res.status(502).json({ error: { message: 'Empty agent response' }, steps }); return; }
    messages.push(msg);
    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      res.json({ message: msg, steps });
      return;
    }
    for (const tc of toolCalls) {
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      const result = await runTool(tc.function?.name, args);
      steps.push({ tool: tc.function?.name, args, result: JSON.parse(result) });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  res.json({ message: messages[messages.length - 1], steps, note: 'Stopped after max tool steps' });
});
