/**
 * Session manager — persists conversations to ~/.oh/sessions/<project-hash>/
 *
 * Each session file: { id, name, model, toolMode, messages,
 *                      compressedHistory, workDir, createdAt, updatedAt }
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { join }        from 'path';
import { homedir }     from 'os';
import { createHash }  from 'crypto';

export class SessionManager {
  constructor(workDir = process.cwd()) {
    this.workDir     = workDir;
    const slug       = createHash('md5').update(workDir).digest('hex').slice(0, 8);
    this.sessionsDir = join(homedir(), '.oh', 'sessions', slug);
    this.currentId   = null;
    this._createdAt  = null;
  }

  async init() {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  newId() {
    // e.g. 2024-01-15T14-30-22
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async save(state, name = null) {
    await this.init();

    if (!this.currentId) {
      this.currentId  = this.newId();
      this._createdAt = new Date().toISOString();
    }

    const firstMsg = state.messages.find((m) => m.role === 'user' && m.content?.trim());

    const data = {
      id:                this.currentId,
      name:              name ?? this.currentId,
      model:             state.model,
      toolMode:          state.toolMode,
      messages:          state.messages,
      compressedHistory: state.compressedHistory ?? null,
      workDir:           this.workDir,
      firstMessage:      firstMsg ? String(firstMsg.content).trim().slice(0, 80) : null,
      createdAt:         this._createdAt,
      updatedAt:         new Date().toISOString(),
    };

    await writeFile(
      join(this.sessionsDir, `${this.currentId}.json`),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
    return this.currentId;
  }

  // ── Load by id or name ──────────────────────────────────────────────────────
  async load(idOrName) {
    await this.init();

    const files = await readdir(this.sessionsDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await readFile(join(this.sessionsDir, f), 'utf-8'));
        if (data.id === idOrName || data.name === idOrName) {
          this.currentId  = data.id;
          this._createdAt = data.createdAt;
          return data;
        }
      } catch { /* skip corrupt file */ }
    }
    return null;
  }

  // ── List (newest first) ─────────────────────────────────────────────────────
  async list() {
    await this.init();

    const files    = await readdir(this.sessionsDir).catch(() => []);
    const sessions = [];

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(join(this.sessionsDir, f), 'utf-8'));
        sessions.push({
          id:           d.id,
          name:         d.name ?? d.id,
          model:        d.model,
          messageCount: d.messages?.length ?? 0,
          firstMessage: d.firstMessage ?? null,
          updatedAt:    d.updatedAt,
        });
      } catch { /* skip */ }
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  async delete(idOrName) {
    const sessions = await this.list();
    const target   = sessions.find((s) => s.id === idOrName || s.name === idOrName);
    if (!target) return false;
    await unlink(join(this.sessionsDir, `${target.id}.json`)).catch(() => {});
    if (this.currentId === target.id) this.currentId = null;
    return true;
  }
}
