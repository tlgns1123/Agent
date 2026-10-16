/**
 * Minimal MCP (Model Context Protocol) client — stdio transport.
 * Connects to an MCP server by spawning it as a child process.
 *
 * Usage:
 *   const client = new McpClient('npx', ['-y', '@modelcontextprotocol/server-filesystem', '.']);
 *   const tools  = await client.connect();
 *   const result = await client.callTool('read_file', { path: 'foo.txt' });
 *   client.disconnect();
 */

import { spawn } from 'child_process';

export class McpClient {
  constructor(command, args = [], name = 'mcp') {
    this.command = command;
    this.args = args;
    this.name = name;
    this.proc = null;
    this.tools = [];
    this._pending = new Map();
    this._nextId = 1;
    this._buffer = '';
  }

  async connect() {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.proc.stderr?.on('data', () => { /* suppress */ });

    this.proc.stdout.on('data', (data) => {
      this._buffer += data.toString();
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this._handleMsg(JSON.parse(trimmed));
        } catch { /* skip malformed */ }
      }
    });

    this.proc.on('error', (err) => {
      for (const [, { reject }] of this._pending) reject(err);
      this._pending.clear();
    });

    // MCP handshake
    await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'oh', version: '0.1.0' },
    });

    const list = await this._send('tools/list', {});
    this.tools = (list.tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: `${this.name}__${t.name}`,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
      _mcp: { client: this, originalName: t.name },
    }));

    return this.tools;
  }

  async callTool(originalName, params) {
    const result = await this._send('tools/call', { name: originalName, arguments: params });
    const content = result.content ?? [];
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { success: true, content: text, raw: result };
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc.stdin.write(msg + '\n');

      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 15_000);
      // Clear the timer if resolved/rejected before timeout to avoid ghost fires
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  _handleMsg(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result ?? {});
    }
  }

  disconnect() {
    this.proc?.kill();
  }
}

/** Load MCP servers from oh.config.json if present */
export async function loadMcpServers(workDir = process.cwd()) {
  const { resolve } = await import('path');
  const { readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');

  const cfgPath = resolve(workDir, 'oh.config.json');
  if (!existsSync(cfgPath)) return [];

  try {
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    const servers = cfg.mcpServers ?? {};
    const clients = [];

    for (const [name, def] of Object.entries(servers)) {
      const client = new McpClient(def.command, def.args ?? [], name);
      clients.push(client);
    }
    return clients;
  } catch {
    return [];
  }
}
