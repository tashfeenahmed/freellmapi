import '../env.js';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { registerMcpTools } from './tools.js';

const MCP_TOKEN = process.env.MCP_TOKEN?.trim();
const MCP_HOST = process.env.MCP_HOST ?? '0.0.0.0';
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '4001', 10);

/** Start the MCP server on MCP_PORT if MCP_TOKEN is configured. */
export async function startMcpServer() {
  if (!MCP_TOKEN) return;

  // ── Auth middleware ──────────────────────────────────────────────────
  const requireMcpToken = (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token !== MCP_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  // ── Express app ──────────────────────────────────────────────────────
  const app = createMcpExpressApp({ host: MCP_HOST });

  // ── MCP transport ────────────────────────────────────────────────────
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  // ── MCP server ───────────────────────────────────────────────────────
  const server = new McpServer({
    name: 'freellmapi-mcp',
    version: '1.0.0',
  });

  registerMcpTools(server);
  await server.connect(transport);

  // ── Route — auth + transport in one handler ─────────────────────────
  app.all('/mcp', requireMcpToken, async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[mcp] handler error:', err?.message ?? err, err?.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP error' });
      }
    }
  });

  transport.onerror = (err: any) => {
    console.error('[mcp] transport error:', err?.message ?? err, err?.stack);
  };

  // ── Listen ───────────────────────────────────────────────────────────
  app.listen(MCP_PORT, MCP_HOST, () => {
    console.log(`[mcp] MCP server listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
  });
}
