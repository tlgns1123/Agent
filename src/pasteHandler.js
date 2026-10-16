/**
 * Paste detection — intercepts large stdin chunks before readline
 * and replaces with [붙여넣기N: X줄] / [이미지N] placeholders.
 *
 * Flow:
 *   stdin ──pipe──> PasteTransform ──> readline
 *                        │
 *                        └─ stores full content in PasteStore
 *
 * On submit, expandPasteRefs() restores placeholders to full content.
 */
import { Transform }  from 'stream';
import { extname }    from 'path';
import { existsSync } from 'fs';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);
const PASTE_MIN  = 80;   // single stdin chunk ≥ this many chars → treat as paste

// ─── Store ────────────────────────────────────────────────────────────────────

export class PasteStore {
  constructor() {
    this.pastes = [];   // { id, content, lines }
    this.images = [];   // { id, path }
  }

  addText(raw) {
    const content = raw.replace(/\r\n/g, '\n').trimEnd();
    const lines   = content.split('\n').filter(l => l.trim()).length || 1;
    const id      = this.pastes.length + 1;
    this.pastes.push({ id, content, lines });
    return { id, lines };
  }

  addImage(path) {
    const id = this.images.length + 1;
    this.images.push({ id, path });
    return id;
  }

  getText(id)  { return this.pastes.find(p => p.id === id)  ?? null; }
  getImage(id) { return this.images.find(i => i.id === id) ?? null; }
}

// ─── Transform stream ─────────────────────────────────────────────────────────

export function buildPasteTransform(store) {
  return new Transform({
    transform(chunk, _enc, cb) {
      const str = chunk.toString('utf-8');

      // ── Image file path paste ────────────────────────────────────────────
      const trimmed = str.trim().replace(/^['"]|['"]$/g, '');
      if (trimmed.length > 4 && IMAGE_EXTS.has(extname(trimmed).toLowerCase())) {
        try {
          if (existsSync(trimmed)) {
            const id = store.addImage(trimmed);
            cb(null, Buffer.from(`[이미지${id}] `));
            return;
          }
        } catch { /* not a valid path */ }
      }

      // ── Large text paste ─────────────────────────────────────────────────
      if (
        str.length >= PASTE_MIN &&
        !str.startsWith('\x1b') &&          // not escape sequence
        !/^[\x00-\x08\x0e-\x1f]/.test(str) // not control chars
      ) {
        const { id, lines } = store.addText(str);
        // No trailing newline — user continues typing instruction on same line
        cb(null, Buffer.from(`[붙여넣기${id}: ${lines}줄] `));
        return;
      }

      cb(null, chunk);
    },
  });
}

// ─── Placeholder expansion ────────────────────────────────────────────────────

const TEXT_REF_RE  = /\[붙여넣기(\d+)(?:: \d+줄)?\]/g;
const IMAGE_REF_RE = /\[이미지(\d+)\]/g;

/**
 * Expand placeholders back to original content.
 * Image refs are converted to @path so existing parseInput() handles them.
 */
export function expandPasteRefs(input, store) {
  let content = input;

  content = content.replace(TEXT_REF_RE, (_, id) => {
    const p = store.getText(parseInt(id, 10));
    return p ? `\n\`\`\`\n${p.content}\n\`\`\`` : '';
  });

  content = content.replace(IMAGE_REF_RE, (_, id) => {
    const img = store.getImage(parseInt(id, 10));
    return img ? `@${img.path}` : '';
  });

  return content;
}
