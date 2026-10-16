/**
 * Dependency scanner — reads lock/manifest files and returns a compact
 * version summary to inject into the system prompt.
 *
 * Supported ecosystems:
 *   Node.js   — package.json
 *   Python    — requirements.txt / pyproject.toml / Pipfile
 *   Rust      — Cargo.toml
 *   Go        — go.mod
 *   PHP       — composer.json
 *   Ruby      — Gemfile
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Returns a markdown string summarising the project's dependencies,
 * or null if no recognisable manifest is found.
 */
export async function buildDepsContext(workDir) {
  const sections = [];

  const node = await readNodeDeps(workDir);
  if (node) sections.push(node);

  const python = await readPythonDeps(workDir);
  if (python) sections.push(python);

  const rust = await readCargoDeps(workDir);
  if (rust) sections.push(rust);

  const golang = await readGoDeps(workDir);
  if (golang) sections.push(golang);

  const php = await readComposerDeps(workDir);
  if (php) sections.push(php);

  const ruby = await readGemfileDeps(workDir);
  if (ruby) sections.push(ruby);

  if (sections.length === 0) return null;

  return `## 프로젝트 기술 스택 (자동 감지)\n\n${sections.join('\n\n')}`;
}

// ─── Node.js ──────────────────────────────────────────────────────────────────

async function readNodeDeps(workDir) {
  const p = join(workDir, 'package.json');
  if (!existsSync(p)) return null;

  try {
    const pkg  = JSON.parse(await readFile(p, 'utf-8'));
    const name = pkg.name ?? '(unnamed)';
    const vers = pkg.version ?? '';
    const lines = [`**Node.js** — ${name}${vers ? ` v${vers}` : ''}`];

    const deps    = Object.entries(pkg.dependencies    ?? {});
    const devDeps = Object.entries(pkg.devDependencies ?? {});

    if (deps.length) {
      lines.push('Dependencies:');
      lines.push(...formatDeps(deps, 30));
    }
    if (devDeps.length) {
      lines.push('Dev dependencies:');
      lines.push(...formatDeps(devDeps, 20));
    }

    const scripts = Object.keys(pkg.scripts ?? {});
    if (scripts.length) lines.push(`Scripts: ${scripts.join(', ')}`);

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ─── Python ───────────────────────────────────────────────────────────────────

async function readPythonDeps(workDir) {
  // pyproject.toml (modern)
  const pyproject = join(workDir, 'pyproject.toml');
  if (existsSync(pyproject)) {
    try {
      const text = await readFile(pyproject, 'utf-8');
      const deps = [];
      // [project] dependencies = [ "pkg>=1.0", ... ]
      const m = text.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (m) {
        deps.push(...m[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) ?? []);
      }
      // [tool.poetry.dependencies]
      const pm = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\[|$)/);
      if (pm) {
        const block = pm[1];
        for (const line of block.split('\n')) {
          const lm = line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/);
          if (lm && lm[1] !== 'python') deps.push(`${lm[1]}==${lm[2]}`);
        }
      }
      if (deps.length) return `**Python** (pyproject.toml)\n${deps.slice(0, 30).map(d => `  ${d}`).join('\n')}`;
    } catch { /* */ }
  }

  // requirements.txt
  const req = join(workDir, 'requirements.txt');
  if (existsSync(req)) {
    try {
      const lines = (await readFile(req, 'utf-8'))
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
        .slice(0, 30);
      if (lines.length) return `**Python** (requirements.txt)\n${lines.map(l => `  ${l}`).join('\n')}`;
    } catch { /* */ }
  }

  return null;
}

// ─── Rust ─────────────────────────────────────────────────────────────────────

async function readCargoDeps(workDir) {
  const p = join(workDir, 'Cargo.toml');
  if (!existsSync(p)) return null;

  try {
    const text = await readFile(p, 'utf-8');
    const nameM = text.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
    const versM = text.match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/);

    const deps = [];
    const depM = text.match(/\[dependencies\]([\s\S]*?)(\[|$)/);
    if (depM) {
      for (const line of depM[1].split('\n')) {
        const lm = line.match(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/);
        const ver = lm[2] ?? lm[3];
        if (lm && ver) deps.push(`${lm[1]} ${ver}`);
      }
    }

    const header = `**Rust** — ${nameM?.[1] ?? ''}${versM ? ` v${versM[1]}` : ''}`;
    return deps.length
      ? `${header}\n${deps.slice(0, 25).map(d => `  ${d}`).join('\n')}`
      : header;
  } catch {
    return null;
  }
}

// ─── Go ───────────────────────────────────────────────────────────────────────

async function readGoDeps(workDir) {
  const p = join(workDir, 'go.mod');
  if (!existsSync(p)) return null;

  try {
    const text  = await readFile(p, 'utf-8');
    const modM  = text.match(/^module\s+(\S+)/m);
    const goM   = text.match(/^go\s+(\S+)/m);
    const lines = [];

    // require block
    const reqM = text.match(/require\s*\(([\s\S]*?)\)/);
    if (reqM) {
      for (const line of reqM[1].split('\n')) {
        const lm = line.trim().match(/^(\S+)\s+(\S+)/);
        if (lm && !lm[0].startsWith('//')) lines.push(`${lm[1]} ${lm[2]}`);
      }
    }

    const header = `**Go** — ${modM?.[1] ?? ''}${goM ? ` (go ${goM[1]})` : ''}`;
    return lines.length
      ? `${header}\n${lines.slice(0, 25).map(l => `  ${l}`).join('\n')}`
      : header;
  } catch {
    return null;
  }
}

// ─── PHP / Composer ───────────────────────────────────────────────────────────

async function readComposerDeps(workDir) {
  const p = join(workDir, 'composer.json');
  if (!existsSync(p)) return null;

  try {
    const pkg  = JSON.parse(await readFile(p, 'utf-8'));
    const name = pkg.name ?? '';
    const deps = Object.entries({ ...(pkg.require ?? {}), ...(pkg['require-dev'] ?? {}) })
      .filter(([k]) => k !== 'php')
      .slice(0, 25)
      .map(([k, v]) => `  ${k}: ${v}`);

    return `**PHP** (Composer)${name ? ` — ${name}` : ''}\n${deps.join('\n')}`;
  } catch {
    return null;
  }
}

// ─── Ruby / Gemfile ───────────────────────────────────────────────────────────

async function readGemfileDeps(workDir) {
  const p = join(workDir, 'Gemfile');
  if (!existsSync(p)) return null;

  try {
    const lines = (await readFile(p, 'utf-8'))
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('gem '))
      .map(l => {
        const m = l.match(/gem ['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?/);
        return m ? `  ${m[1]}${m[2] ? ` ${m[2]}` : ''}` : null;
      })
      .filter(Boolean)
      .slice(0, 25);

    return lines.length ? `**Ruby** (Gemfile)\n${lines.join('\n')}` : null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDeps(entries, limit) {
  return entries
    .slice(0, limit)
    .map(([name, ver]) => `  ${name}: ${ver}`);
}
