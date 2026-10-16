/**
 * BackupManager — snapshot files before modification or deletion.
 * /undo restores from the most recent snapshot.
 */

import { readFile, writeFile, copyFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { createHash } from 'crypto';
import os from 'os';

const BACKUP_DIR = join(os.homedir(), '.ooh', 'backup');
const MAX_STACK  = 50;

export class BackupManager {
  constructor(workDir) {
    this.workDir = workDir;
    this._stack  = []; // { absPath, displayPath, ts, backupPath }
  }

  /** Save a snapshot of absPath. Silently skips if the file doesn't exist yet. */
  async backup(absPath) {
    if (!existsSync(absPath)) return;

    try {
      await mkdir(BACKUP_DIR, { recursive: true });

      const ts     = Date.now();
      const hash   = createHash('md5').update(absPath + ts).digest('hex').slice(0, 8);
      const bkName = `${basename(absPath)}.${ts}.${hash}.bak`;
      const bkPath = join(BACKUP_DIR, bkName);

      await copyFile(absPath, bkPath);

      const displayPath = relative(this.workDir, absPath).replace(/\\/g, '/');
      this._stack.push({ absPath, displayPath, ts, backupPath: bkPath });

      // Evict oldest entries if stack overflows (await to prevent disk accumulation)
      while (this._stack.length > MAX_STACK) {
        const evicted = this._stack.shift();
        await unlink(evicted.backupPath).catch(() => {});
      }
    } catch {
      // Non-fatal — backup failure must never block the main operation
    }
  }

  /** Restore the most recently backed-up file. */
  async undo() {
    if (this._stack.length === 0) {
      return { ok: false, message: '되돌릴 변경사항이 없습니다.' };
    }

    const entry = this._stack.pop();
    try {
      const content = await readFile(entry.backupPath);
      await writeFile(entry.absPath, content);
      return { ok: true, message: `복원 완료: ${entry.displayPath}`, entry };
    } catch (err) {
      this._stack.push(entry); // put back on failure
      return { ok: false, message: `복원 실패: ${err.message}` };
    }
  }

  /** Return the backup stack (newest first) for display. */
  list() {
    return this._stack.slice().reverse().map(e => ({
      path: e.displayPath,
      time: new Date(e.ts).toLocaleTimeString(),
    }));
  }
}
