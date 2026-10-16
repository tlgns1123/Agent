/**
 * /init — project analysis.
 *
 * Scans the working directory, reads key files, then produces:
 *   AGENTS.md — project knowledge base & AI instructions (system prompt)
 *   MEMORY.md — initialized as an empty dated work log
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import { existsSync }              from 'fs';
import { exec }                    from 'child_process';
import { promisify }               from 'util';

const execP = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', '.output',
  '.cache', '__pycache__', '.venv', 'venv', 'env', '.next', '.nuxt',
  'coverage', '.nyc_output', 'tmp', 'temp', '.turbo', '.parcel-cache',
]);

const PRIORITY_FILES = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json',
  'README.md', 'readme.md', 'README', 'AGENTS.md',
  '.env.example', 'Makefile', 'Dockerfile', 'docker-compose.yml',
];

const CONFIG_EXTS = new Set(['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf']);
const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp',
]);
const DOC_EXTS    = new Set(['.md', '.txt', '.rst']);

const MAX_DEPTH      = 6;
const MAX_FILE_BYTES = 50_000;
const SOURCE_LINES   = 200;

/** Convert context window (tokens) → safe char budget for file content. */
export function ctxToCharLimit(contextLength) {
  // Reserve ~2K tokens for prompt shell + LLM output. 1 token ≈ 3 chars.
  return Math.max(8_000, (( contextLength ?? 8192) - 2000) * 3);
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

export async function gatherProjectContext(workDir, contextLength) {
  const charLimit = ctxToCharLimit(contextLength);
  const tree    = [];
  const content = {};

  for (const name of PRIORITY_FILES) {
    const p = join(workDir, name);
    if (existsSync(p)) {
      try { content[name] = (await readFile(p, 'utf-8')).slice(0, MAX_FILE_BYTES); }
      catch { /* ignore */ }
    }
  }

  await walkDir(workDir, workDir, 0, tree, content, charLimit);

  const runtimes = await detectRuntimes();

  return { tree, content, runtimes };
}

// ─── Runtime version detection ────────────────────────────────────────────────

async function detectRuntimes() {
  const checks = [
    { name: 'Node.js',  cmd: 'node --version' },
    { name: 'npm',      cmd: 'npm --version' },
    { name: 'Python',   cmd: 'python --version' },
    { name: 'Python3',  cmd: 'python3 --version' },
    { name: 'Go',       cmd: 'go version' },
    { name: 'Rust',     cmd: 'rustc --version' },
    { name: 'Java',     cmd: 'java -version' },
    { name: 'Ruby',     cmd: 'ruby --version' },
    { name: 'PHP',      cmd: 'php --version' },
    { name: 'Bun',      cmd: 'bun --version' },
    { name: 'Deno',     cmd: 'deno --version' },
  ];

  const results = await Promise.all(
    checks.map(async ({ name, cmd }) => {
      try {
        const { stdout, stderr } = await execP(cmd, { timeout: 5000 });
        const raw = (stdout || stderr).split('\n')[0].trim();
        if (!raw) return null;
        // Extract just the version number/string
        const ver = raw.replace(/^(node |go |rustc |ruby |PHP |Bun |Deno )/i, '').trim();
        return `${name}: ${ver}`;
      } catch {
        return null;
      }
    }),
  );

  // Deduplicate Python (keep whichever responded)
  const lines = results.filter(Boolean);
  const hasPython  = lines.some(l => l.startsWith('Python:'));
  const hasPython3 = lines.some(l => l.startsWith('Python3:'));
  return lines.filter(l => !(hasPython && l.startsWith('Python3:')))
              .map(l => l.replace('Python3:', 'Python:'));
}

async function walkDir(root, dir, depth, tree, content, charLimit) {
  if (depth > MAX_DEPTH) return;

  const used = () => Object.values(content).reduce((s, v) => s + v.length, 0);

  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const absPath = join(dir, entry.name);
    const relPath = relative(root, absPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      tree.push(relPath + '/');
      await walkDir(root, absPath, depth + 1, tree, content, charLimit);
    } else {
      tree.push(relPath);
      if (content[entry.name] !== undefined) continue;
      if (used() >= charLimit) continue; // budget exhausted — record path but skip content
      const ext = extname(entry.name).toLowerCase();
      try {
        const info = await stat(absPath);
        if (info.size > MAX_FILE_BYTES) continue;
        if (CONFIG_EXTS.has(ext) || DOC_EXTS.has(ext)) {
          content[relPath] = await readFile(absPath, 'utf-8');
        } else if (SOURCE_EXTS.has(ext)) {
          const lines = (await readFile(absPath, 'utf-8')).split('\n');
          content[relPath] =
            lines.slice(0, SOURCE_LINES).join('\n') +
            (lines.length > SOURCE_LINES ? `\n  … (${lines.length - SOURCE_LINES} more lines)` : '');
        }
      } catch { /* ignore */ }
    }
  }
}

// ─── Static AGENTS.md generator (no LLM) ─────────────────────────────────────
// Produces a complete AGENTS.md directly from the gathered context.
// No model call → no loops, no timeouts, instant result.

export function generateAgentsMd({ tree, content, runtimes = [] }, workDir) {
  const name = workDir.split(/[/\\]/).filter(Boolean).pop() ?? 'project';

  // ── Tech stack from manifests ───────────────────────────────────────────────
  const deps = extractDeps(content);

  // ── Key files (non-trivial, non-config top-level entries) ───────────────────
  const keyFiles = inferKeyFiles(tree, content);

  // ── Dev commands ────────────────────────────────────────────────────────────
  const devCmds = inferDevCommands(content);

  // ── File tree (trimmed) ─────────────────────────────────────────────────────
  const treeLines = tree.slice(0, 80).join('\n');

  const runtimeSection = runtimes.length
    ? runtimes.map(r => `- ${r}`).join('\n')
    : '- (감지 실패)';

  const depSection = deps.length
    ? deps.map(d => `- ${d}`).join('\n')
    : '- (매니페스트 없음)';

  const keyFileSection = keyFiles.length
    ? keyFiles.map(([f, desc]) => `- \`${f}\` — ${desc}`).join('\n')
    : tree.slice(0, 10).map(f => `- \`${f}\``).join('\n');

  const devSection = devCmds.length
    ? devCmds.join('\n')
    : '- (자동 감지 실패 — 직접 입력하세요)';

  return `# Project: ${name}

## Overview
<!-- /init이 자동 생성했습니다. 프로젝트 설명을 여기에 작성하세요. -->

## Tech Stack

### Runtimes (이 머신)
${runtimeSection}

### Dependencies
${depSection}

## Key Files
${keyFileSection}

## Architecture
<!-- 아키텍처 설명을 여기에 작성하세요. -->

## Conventions
- 코드 스타일은 기존 파일을 따를 것
- 불필요한 복잡성, 중복 코드 금지

## Development
${devSection}

## AI Guidelines
- 요청받은 것만 수행. 요청하지 않은 파일을 읽거나 수정하지 말 것
- 수정이 필요한 파일만 read_file로 확인. 프로젝트 전체를 탐색하지 말 것
- 응답은 핵심만 짧게 — 파일 내용 재출력 금지, 완료 후 한 줄 요약만
- 같은 툴을 반복 호출하지 말 것
- 라이브러리 사용 시 알고 있는 지식으로 코드 작성. 사용자가 명시적으로 요청할 때만 web_search 사용
- 파일 수정 후 run_command로 빌드/컴파일/린트를 실행해 오류를 검증할 것 (사용자가 허용할 경우)

## File Tree
\`\`\`
${treeLines}${tree.length > 80 ? `\n… (${tree.length - 80}개 더)` : ''}
\`\`\`
`;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function extractDeps(content) {
  const deps = [];

  // package.json
  const pkg = tryJson(content['package.json']);
  if (pkg) {
    if (pkg.name)    deps.push(`Node.js project: ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const notable = Object.entries(allDeps)
      .filter(([k]) => /^(react|next|vue|nuxt|svelte|express|fastify|nestjs|prisma|drizzle|tailwind|vite|webpack|typescript|jest|vitest)/.test(k))
      .slice(0, 15)
      .map(([k, v]) => `${k} ${v}`);
    deps.push(...notable);
  }

  // pyproject.toml / requirements (rough)
  const pyproject = content['pyproject.toml'];
  if (pyproject) {
    const nameM = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameM) deps.push(`Python project: ${nameM[1]}`);
    const deps2 = [...pyproject.matchAll(/^\s*"?([a-z][\w-]+)\s*[>=<~^]/gmi)].slice(0, 10).map(m => m[1]);
    deps.push(...deps2);
  }

  // Cargo.toml
  const cargo = content['Cargo.toml'];
  if (cargo) {
    const nameM = cargo.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameM) deps.push(`Rust project: ${nameM[1]}`);
  }

  // go.mod
  const gomod = content['go.mod'];
  if (gomod) {
    const modM = gomod.match(/^module\s+(\S+)/m);
    if (modM) deps.push(`Go module: ${modM[1]}`);
  }

  return [...new Set(deps)];
}

function tryJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function inferKeyFiles(tree, content) {
  const result = [];
  const LABELS = {
    'package.json':       'Node.js 매니페스트',
    'tsconfig.json':      'TypeScript 설정',
    'vite.config.js':     'Vite 설정',
    'vite.config.ts':     'Vite 설정',
    'next.config.js':     'Next.js 설정',
    'next.config.ts':     'Next.js 설정',
    'Dockerfile':         'Docker 이미지 정의',
    'docker-compose.yml': 'Docker Compose 설정',
    'Makefile':           '빌드 태스크',
    'README.md':          '프로젝트 문서',
    'AGENTS.md':          'AI 지침',
  };
  // Priority files first
  for (const [name, label] of Object.entries(LABELS)) {
    if (tree.includes(name) || tree.some(f => f.endsWith('/' + name))) {
      result.push([name, label]);
    }
  }
  // Source entry points
  const ENTRIES = ['src/index.js','src/index.ts','src/main.js','src/main.ts','src/app.js','src/app.ts',
                   'index.js','main.js','app.js','main.py','app.py','main.go','src/lib.rs'];
  for (const e of ENTRIES) {
    if (tree.includes(e) && !result.some(([f]) => f === e)) {
      result.push([e, '엔트리포인트']);
    }
  }
  return result.slice(0, 12);
}

function inferDevCommands(content) {
  const cmds = [];
  const pkg = tryJson(content['package.json']);
  if (pkg?.scripts) {
    const s = pkg.scripts;
    cmds.push(`\`npm install\` — 의존성 설치`);
    if (s.dev)               cmds.push(`\`npm run dev\` — 개발 서버`);
    if (s.start)             cmds.push(`\`npm start\` — 실행`);
    if (s.build)             cmds.push(`\`npm run build\` — 빌드`);
    if (s.test)              cmds.push(`\`npm test\` — 테스트`);
  }
  if (content['Makefile']) {
    const targets = [...content['Makefile'].matchAll(/^([a-zA-Z][\w-]+)\s*:/gm)]
      .map(m => m[1]).filter(t => !t.startsWith('.')).slice(0, 5);
    targets.forEach(t => cmds.push(`\`make ${t}\``));
  }
  if (content['pyproject.toml'] || content['requirements.txt']) {
    cmds.push('`pip install -r requirements.txt` — 의존성 설치');
    cmds.push('`python main.py` — 실행');
  }
  if (content['go.mod']) {
    cmds.push('`go mod tidy` — 의존성 정리');
    cmds.push('`go run .` — 실행');
    cmds.push('`go build` — 빌드');
  }
  if (content['Cargo.toml']) {
    cmds.push('`cargo build` — 빌드');
    cmds.push('`cargo run` — 실행');
    cmds.push('`cargo test` — 테스트');
  }
  return cmds;
}

// ─── AGENTS.md prompt (kept for reference / manual use) ──────────────────────

export function buildAgentsPrompt({ tree, content, runtimes = [] }) {
  const fileTree = tree.join('\n');
  const sections = [];
  let charCount  = fileTree.length;

  for (const [path, text] of Object.entries(content)) {
    const section = `\n### ${path}\n\`\`\`\n${text}\n\`\`\``;
    if (charCount + section.length > ctxToCharLimit(null)) continue;
    sections.push(section);
    charCount += section.length;
  }

  return `Analyze this software project and generate an AGENTS.md file.

AGENTS.md is the AI assistant's system prompt when working on this project.
It must contain exactly these sections:

# Project: [name]

## Overview
2-3 sentences describing what this project does and its purpose.

## Tech Stack
Detected runtime versions on this machine:
${runtimes.length ? runtimes.map(r => `- ${r}`).join('\n') : '- (감지 실패)'}

List every language, runtime, framework, and key library WITH its exact version from the manifest files.
For each major dependency, note:
- The version in use (e.g. React 18.3, Next.js 15, Python 3.11)
- Any version-specific patterns or APIs that differ from older versions
- Migration notes if the version is recent (e.g. "Next.js 15 uses async params")

## Key Files
The most important files and what each one does. Focus on entry points, core modules, config files.

## Architecture
How the system is structured: data flow, layers, key patterns used.

## Conventions
Naming conventions, code style, patterns to follow, things to avoid.
Include version-specific idioms: e.g. "use React hooks, not class components", "use async/await, not callbacks".

## Development
Exact commands to install dependencies, run the project, run tests, build.

## AI Guidelines
Specific instructions for an AI assistant working on this codebase:
- What to do before modifying files
- Which tools to prefer
- For library usage: write code from existing knowledge. Only use web_search/web_fetch when the user explicitly requests it
- Any project-specific rules or gotchas
- What to verify after making changes
- Keep responses short: no long explanations, no repeating file contents back to the user, one-line summaries after tool use

Be precise and practical. This file will be read by an AI on every session start.

## File tree
\`\`\`
${fileTree}
\`\`\`

## File contents
${sections.join('\n')}

Generate AGENTS.md now:`;
}

// ─── MEMORY.md initialization content ────────────────────────────────────────
// Just a clean header — work entries are added by /update.

export function buildMemoryInit(workDir) {
  const name = workDir.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
  const date = new Date().toISOString().split('T')[0];
  return `# Work Log — ${name}\n\nInitialized: ${date}\n\n---\n\n`;
}

// ─── /update prompts ──────────────────────────────────────────────────────────

/**
 * Prompt to generate a MEMORY.md work log entry from a conversation.
 * Returns a dated markdown section to append.
 */
export function buildWorkLogPrompt(conversationText) {
  const date = new Date().toISOString().split('T')[0];
  return `Summarize this conversation as a work log entry for a developer journal.

Today's date: ${date}

Write ONLY a brief markdown section (no date header — that will be added automatically).
Include:
- **What was done** — bullet list of completed tasks/changes
- **Files modified** — list of files created, edited, or deleted
- **Key decisions** — important choices made and why (skip if none)
- **Remaining tasks** — unfinished items explicitly mentioned (skip if none)

Rules:
- Write from a third-person/log perspective, not conversational
- Be specific about file names and function names
- Omit sections that are empty
- Maximum 200 words

Conversation:
${conversationText}

Write the work log entry:`;
}

/**
 * Prompt to update AGENTS.md based on new project knowledge from a conversation.
 */
export function buildAgentsUpdatePrompt(currentAgents, workSummary) {
  return `You are maintaining a project knowledge file (AGENTS.md).

Current AGENTS.md:
\`\`\`markdown
${currentAgents}
\`\`\`

New knowledge from recent work session:
${workSummary}

Update AGENTS.md to reflect any NEW stable project-level knowledge discovered.

Rules:
- ONLY update what actually changed or was newly discovered
- Do NOT add task history (that belongs in MEMORY.md)
- Keep all existing accurate information
- Add new entries to relevant sections (tech stack, key files, conventions, etc.)
- If nothing meaningful changed for AGENTS.md, return it unchanged

Return the complete updated AGENTS.md:`;
}
