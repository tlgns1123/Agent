#!/usr/bin/env node
/**
 * OH — Ollama Helper
 * Main entry point & REPL loop
 */

import readline from 'readline';
import chalk    from 'chalk';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve, extname, join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import os from 'os';

// .env 로드 (dotenv 없이 직접 파싱)
const __envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(__envPath)) {
  for (const line of readFileSync(__envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { PasteStore, buildPasteTransform, expandPasteRefs } from './pasteHandler.js';
import { ping, listModels, streamChat, setBaseUrl } from './ollama.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { MemoryManager }                            from './memory.js';
import { PluginManager }                            from './plugins.js';
import { SessionManager }                           from './session.js';
import { loadMcpServers }                           from './mcp.js';
import { agentIters, AGENT_DIRECTIVE } from './router.js';
import { isCommand, handleCommand } from './commands.js';
import { PermissionManager, makeAskFn }              from './permissions.js';
import { BackupManager }                             from './backup.js';
import { getGitContext, githubFetchIssue }           from './git.js';
import { buildDepsContext }                          from './deps.js';
import { verifyAnswer, presentVerification }         from './verify.js';
import { execVerifyEnabled, runExecVerification, presentExecVerification } from './execverify.js';
import { sandboxEnabled, checkSandbox, sandboxLabel } from './sandbox.js';

// ─── Input helpers (@images, @folders, @#issues) ──────────────────────────────

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);
const TEXT_EXTS  = new Set(['.js','.ts','.jsx','.tsx','.mjs','.cjs',
  '.py','.go','.rs','.java','.c','.cpp','.h','.cs','.rb','.php','.swift',
  '.kt','.vue','.svelte','.html','.css','.scss','.json','.yaml','.yml',
  '.toml','.md','.txt','.sh','.bash','.zsh','.env','.gitignore','.sql']);
const SKIP_DIRS  = new Set(['node_modules','.git','dist','build','.cache','__pycache__','coverage','.next','.nuxt']);

const REF_RE = /@([^\s@"']+)/g;

async function parseInput(input, githubCfg) {
  const refs = [...input.matchAll(REF_RE)];
  if (refs.length === 0) return { content: input, images: undefined, extraContext: '' };

  const images       = [];
  let   content      = input;
  const ctxParts     = [];

  for (const match of refs) {
    const raw = match[1];

    // ── @#123 or @owner/repo#123 — GitHub issue/PR ────────────────────────
    const issueM = raw.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
    if (issueM) {
      const repoStr = issueM[1];
      const num     = parseInt(issueM[2], 10);
      const owner   = repoStr ? repoStr.split('/')[0] : githubCfg?.owner;
      const repo    = repoStr ? repoStr.split('/')[1] : githubCfg?.repo;
      const token   = githubCfg?.token;
      if (owner && repo) {
        try {
          const issue = await githubFetchIssue(owner, repo, num, token);
          if (issue) {
            ctxParts.push(
              `## GitHub ${issue.type} #${issue.number}: ${issue.title}\n` +
              `State: ${issue.state}  Labels: ${issue.labels.join(', ') || 'none'}\n` +
              `URL: ${issue.url}\n\n${issue.body}`,
            );
            content = content.replace(match[0], `[${issue.type} #${num}: ${issue.title}]`);
            continue;
          }
        } catch { /* leave as-is */ }
      }
      continue;
    }

    const full = resolve(process.cwd(), raw);

    // ── @path/ or @dir — folder context ──────────────────────────────────
    let isDir = false;
    try { isDir = (await stat(full)).isDirectory(); } catch { /* */ }

    if (isDir || raw.endsWith('/') || raw.endsWith('\\')) {
      const folderContent = await readFolderContext(full);
      if (folderContent) {
        ctxParts.push(`## Folder: ${raw}\n\n${folderContent}`);
        content = content.replace(match[0], `[folder: ${raw}]`);
      }
      continue;
    }

    // ── @image.png ────────────────────────────────────────────────────────
    const ext = extname(raw).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const buf = await readFile(full);
        images.push(buf.toString('base64'));
        content = content.replace(match[0], `[image: ${raw}]`);
      } catch { /* leave as-is */ }
    }
  }

  return {
    content,
    images:       images.length > 0 ? images : undefined,
    extraContext: ctxParts.join('\n\n---\n\n'),
  };
}

async function readFolderContext(dirPath, maxFiles = 20, maxBytes = 80_000) {
  const parts = [];
  let totalBytes = 0;

  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (parts.length >= maxFiles || totalBytes >= maxBytes) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
      } else if (TEXT_EXTS.has(extname(e.name).toLowerCase())) {
        try {
          const s = await stat(abs);
          if (s.size > 50_000) continue;
          const text = await readFile(abs, 'utf-8');
          const rel  = relative(dirPath, abs).replace(/\\/g, '/');
          parts.push(`### ${rel}\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\``);
          totalBytes += text.length;
        } catch { /* skip */ }
      }
    }
  }

  await walk(dirPath);
  return parts.join('\n\n');
}
import {
  printWelcome, printAssistantLabel, printToken,
  printToolUse, printToolResult, printError, printSystem, printInfo,
  printThinkingStart, printThinkingEnd, printStatus, printTokenCount,
  printEditDiff, printWriteSummary, printCommandOutput,
  getUserPrompt, ThinkFilter, CodeBlockFilter, printCodeBlock, startSpinner,
} from './ui.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// 기본 모델: qwen3:14b (2026-10-17 WRN 폐기, 단일 네이티브 툴콜 모델로 확정).
// 16GB VRAM에 12.2GB 완전상주, 40tok/s. 바꾸려면 OH_MODEL 환경변수 또는 /model.
const DEFAULT_MODEL       = process.env.OH_MODEL || 'qwen3:14b';
// 기본 컨텍스트 길이. Phase5 실측(2026-10-17): 16384로 올려도 16GB VRAM 내 완전상주 가능.
// env OH_NUM_CTX(기본 16384).
const DEFAULT_NUM_CTX     = Math.max(2048, parseInt(process.env.OH_NUM_CTX ?? '16384', 10) || 16384);
const DEFAULT_ITERATIONS  = 3;
const COMPACT_KEEP_RECENT = 12;   // messages preserved verbatim after compaction
const AUTO_SAVE_EVERY     = 4;    // save session every N messages

/**
 * Compact threshold: how many messages before summarising old history.
 * Tied to context window — larger context = more messages before compaction.
 * Rough rule: allow ~60% of context for history, ~200 tokens per message avg.
 */
function compactThreshold(contextLength) {
  const tokens = contextLength ?? DEFAULT_NUM_CTX;
  return Math.max(10, Math.floor(tokens * 0.6 / 200));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  // ── CLI args: oh [model] [--host <url>] [--session <id>] ─────────────────
  const argv  = process.argv.slice(2);
  let   model = DEFAULT_MODEL;
  let   resumeSession = null;

  let cliModelSet = false;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--host' || argv[i] === '-H') && argv[i + 1]) {
      setBaseUrl(argv[++i]);
    } else if ((argv[i] === '--session' || argv[i] === '-s') && argv[i + 1]) {
      resumeSession = argv[++i];
    } else if (!argv[i].startsWith('-')) {
      model = argv[i];
      cliModelSet = true;
    }
  }

  // ── Ollama reachability ───────────────────────────────────────────────────
  const alive = await ping();
  if (!alive) {
    console.log('\n  Error: Cannot connect to Ollama.\n  Run: ollama serve\n');
    process.exit(1);
  }

// ── Subsystem init ────────────────────────────────────────────────────────
  const memory   = new MemoryManager(process.cwd());
  const plugins  = new PluginManager(process.cwd());
  const sessions = new SessionManager(process.cwd());
  await plugins.load();
  await sessions.init();

  const mcpClients = await loadMcpServers(process.cwd());
  const mcpTools   = [];
  for (const client of mcpClients) {
    try {
      const tools = await client.connect();
      mcpTools.push(...tools);
    } catch (err) {
      printError(`MCP connect failed (${client.name}): ${err.message}`);
    }
  }

  const allTools = [...TOOL_DEFINITIONS, ...plugins.allTools(), ...mcpTools];

  const backup = new BackupManager(process.cwd());

  // ── AGENTS.md 초기화 ──────────────────────────────────────────────────────
  const initResult = await memory.initAgentsIfNeeded();
  if (initResult === 'from-conventions') {
    printSystem('CONVENTIONS.md → AGENTS.md로 이전 완료. CONVENTIONS.md는 삭제됐습니다.');
  } else if (initResult === 'from-default') {
    printSystem('AGENTS.md가 없어 기본 컨벤션으로 생성했습니다. /init 으로 프로젝트 분석을 실행하세요.');
  }

  // ── AGENTS.md에서 설정 읽기 ───────────────────────────────────────────────
  const savedCfg = await memory.readModelSection();

  // Priority: CLI arg > AGENTS.md > default (interactive selection happens after)
  if (savedCfg?.model && !cliModelSet) model = savedCfg.model;

  // ── Interactive model selection (skipped if model set via CLI or AGENTS.md) ─
  if (!cliModelSet) {
    model = await promptSelectModel(model);
  }

  // GitHub: AGENTS.md 우선, 환경변수로 token 보완
  const githubCfg = savedCfg?.github
    ? { ...savedCfg.github, token: process.env.GITHUB_TOKEN ?? null }
    : (process.env.GITHUB_OWNER && process.env.GITHUB_REPO)
      ? { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, token: process.env.GITHUB_TOKEN ?? null }
      : null;

  const state = {
    model,
    messages:          [],
    compressedHistory: null,
    toolMode:          'auto',
    contextLength:     savedCfg?.contextLength ?? null,
    config: {
      temperature:    savedCfg?.temperature    ?? 0.8,
      top_p:          savedCfg?.top_p          ?? 0.9,
      iterations:     savedCfg?.iterations     ?? DEFAULT_ITERATIONS,
      effort:         savedCfg?.effort         ?? 'normal',
      search_results: savedCfg?.search_results ?? 5,
    },
    memory,
    plugins,
    sessions,
    mcpClients,
    allTools,
    listModels,
    permissions: new PermissionManager(),
    backup,
    _github:     githubCfg,
    _watcher:    null,
    _watchQueue: [],
    _rl:         null,
  };

  // ── Resume session if requested ───────────────────────────────────────────
  if (resumeSession) {
    const saved = await sessions.load(resumeSession);
    if (saved) {
      state.messages          = saved.messages ?? [];
      state.compressedHistory = saved.compressedHistory ?? null;
      state.model             = saved.model ?? model;
      state.toolMode          = saved.toolMode ?? 'auto';
      printInfo(`Resumed session: ${saved.name}  (${state.messages.length} messages)`);
    } else {
      printSystem(`Session not found: ${resumeSession}`);
    }
  }

  printWelcome(state.model);

  // 단일 모델(네이티브 툴콜) 전제 — 라우터/모델스왑 없음. 에이전트 턴 반복상한만 둔다.
  state._turnMaxIter = null;

  // ── 실행 격리(샌드박스) 상태 표시 + 안전점검 ─────────────────────────────
  if (sandboxEnabled()) {
    const chk = checkSandbox();
    if (chk.ok) {
      printSystem(`🔒 실행 격리 ON — run_command/run_code는 '${chk.distro}'(WSL) 안에서 실행됩니다. 윈도우 파일·실행 차단.`);
    } else {
      printError(`샌드박스 '${chk.distro}' 사용 불가: ${chk.error}`);
      printSystem('→ 안전을 위해 host 직접 실행으로 폴백합니다. (배포판 확인 후 OH_SANDBOX=wsl 재시도)');
      process.env.OH_SANDBOX = 'host';
    }
  } else {
    printSystem(chalk.dim('실행 격리 OFF — 명령/코드는 호스트에서 직접 실행됩니다. 격리하려면 OH_SANDBOX=wsl'));
  }

  // ── 모델 설정을 AGENTS.md에 기록 (변경됐거나 블록 없을 때) ────────────────
  await memory.updateModelSection(state.model, state.contextLength, state.config, githubCfg);

  // ── Load AGENTS.md / RULES.md / MEMORY.md ────────────────────────────────
  const buildSystemPrompt = async () => {
    const memFiles = await memory.loadAll();
    let sp = memory.buildSystemPrompt(memFiles);
    // 현재 날짜 주입 — 모델이 "최신" 연도를 학습 컷오프 기준으로 착각하지 않도록
    const today = new Date().toISOString().split('T')[0];
    const dateCtx = `오늘 날짜: ${today}. 검색·정보 요청 시 이 날짜 기준으로 "최신", "최근", "현재"를 판단할 것.`;
    sp = sp ? `${dateCtx}\n\n${sp}` : dateCtx;
    const depsCtx = await buildDepsContext(process.cwd()).catch(() => null);
    if (depsCtx) sp = sp ? `${sp}\n\n${depsCtx}` : depsCtx;
    const gitCtx = await getGitContext(process.cwd()).catch(() => null);
    if (gitCtx)  sp = sp ? `${sp}\n\n${gitCtx}`  : gitCtx;
    return sp;
  };

  state._reloadSystemPrompt = async () => {
    state._systemPrompt = await buildSystemPrompt();
  };

  state._systemPrompt = await buildSystemPrompt();

  // ── Paste interceptor (must be created before readline) ──────────────────
  const pasteStore     = new PasteStore();
  state._pasteStore    = pasteStore;
  const pasteTransform = buildPasteTransform(pasteStore);

  // Proxy TTY properties so readline treats the transform as a real terminal
  pasteTransform.isTTY = process.stdin.isTTY ?? true;
  if (process.stdin.setRawMode) {
    pasteTransform.setRawMode = (mode) => {
      process.stdin.setRawMode(mode);
      return pasteTransform;
    };
  }
  process.stdin.on('end',   () => pasteTransform.end());
  process.stdin.on('close', () => pasteTransform.destroy());
  process.stdin.pipe(pasteTransform);

  // ── readline ──────────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input:       pasteTransform,
    output:      process.stdout,
    terminal:    true,
    historySize: 500,
  });

  state._rl = rl;

  // ── Permission ask function ───────────────────────────────────────────────
  const permAskFn = makeAskFn(rl);

  // ── Ctrl+C / exit handling ────────────────────────────────────────────────
  // activeAbort is set while a stream is in progress.
  // First Ctrl+C cancels the stream; second Ctrl+C exits.
  let activeAbort = null;
  let exiting     = false;

  const doExit = async () => {
    if (exiting) return;
    exiting = true;
    if (state._watcher) { state._watcher.close(); state._watcher = null; }
    // Don't call rl.close() yet — avoid triggering the close→doExit loop
    await sessions.save(state).catch(() => {});
    await autoSummarize(state);
    for (const c of mcpClients) c.disconnect();
    console.log('\n  Goodbye!\n');
    process.exit(0);
  };

  rl.on('close', doExit);

  // On Windows, Ctrl+C may fire rl 'SIGINT' instead of (or in addition to)
  // process 'SIGINT'. Register the same handler on both and deduplicate.
  let _sigintLast  = 0;
  let _sigintStamp = 0;

  const handleSigint = () => {
    // Deduplicate: rl and process can fire multiple times for one keypress on Windows
    const now = Date.now();
    if (now - _sigintStamp < 200) return;
    _sigintStamp = now;

    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      process.stdout.write('\n');
      _sigintLast = now;
      process.stdout.write(chalk.dim('  (한 번 더 누르면 종료)\n'));
      return;
    }
    if (state._inModelPull) return;
    // Idle: first press hints, second press within 3s exits
    if (now - _sigintLast > 0 && now - _sigintLast < 3000) {
      doExit();
      return;
    }
    _sigintLast = now;
    process.stdout.write(chalk.dim('\n  (한 번 더 누르면 종료)\n'));
    // Do NOT call rl.write('') — it can reset readline state and swallow next Ctrl+C
  };

  rl.on('SIGINT', handleSigint);
  process.on('SIGINT', handleSigint);

  // ── REPL loop ─────────────────────────────────────────────────────────────
  // Supports multi-line input: end a line with \ to continue on the next line.
  // An empty continuation line (just Enter) also submits.
  const prompt = (accumulated = '') => {
    const p = accumulated
      ? chalk.dim('  ... ')
      : getUserPrompt(state.model);

    rl.question(p, async (raw) => {
      // Line continuation: ends with backslash
      if (raw.endsWith('\\')) {
        prompt(accumulated + raw.slice(0, -1) + '\n');
        return;
      }

      const input = (accumulated + raw).trim();
      if (!input) { prompt(); return; }

      // Add to readline history so up-arrow works
      if (raw.trim() && !accumulated) {
        rl.history.unshift(raw);
        if (rl.history.length > (rl.historySize ?? 500)) rl.history.pop();
      }

      if (isCommand(input)) {
        const cmdResult = await handleCommand(input, state);
        if (cmdResult?.exit) { await doExit(); return; }
        // Reload system prompt if AGENTS.md or MEMORY.md may have changed
        if (/^\/(init|update|memory|cd)\b/.test(input)) {
          await state._reloadSystemPrompt();
        }
        prompt();
        return;
      }

      // ── Watch queue notification ───────────────────────────────────────
      if (state._watchQueue?.length > 0) {
        const changes = state._watchQueue.splice(0);
        const summary = changes.slice(0, 8).map(c => `  ${chalk.dim(c.type.padEnd(8))} ${c.path}`).join('\n');
        console.log(`\n${chalk.yellow('  ◈ 파일 변경 감지')} ${chalk.dim(`(${changes.length}개)`)}\n${summary}\n`);
      }

      // ── Expand paste/image placeholders ([붙여넣기N], [이미지N]) ──────────
      const expandedInput = state._pasteStore
        ? expandPasteRefs(input, state._pasteStore)
        : input;

      // ── Parse @refs (images, folders, GitHub issues) ──────────────────
      const { content: msgContent, images: fileImages, extraContext } =
        await parseInput(expandedInput, state._github);
      const allImages = [
        ...(state._pendingImages ?? []),
        ...(fileImages ?? []),
      ];
      state._pendingImages = [];

      let finalContent = msgContent;
      if (extraContext) finalContent = `${extraContext}\n\n---\n\n${msgContent}`;

      const userMsg = { role: 'user', content: finalContent };
      if (allImages.length > 0) {
        userMsg.images = allImages;
        printSystem(`Attaching ${allImages.length} image(s) to message.`);
      }
      state.messages.push(userMsg);

      // ── 지식 근거 확보: RAG(지식DB) 먼저 → 없으면 신뢰소스(NVD)/웹 자동 폴백 ──
      await autoGround(state, expandedInput);

      // ── 단일 모델: 매 턴 행동지시문 + 에이전트 반복상한 적용 ──
      // (autoGround가 Q&A 근거를 미리 주입하므로, 지시문이 붙어도 순수 질의는 바로 답한다.)
      state._turnMaxIter = agentIters();
      const turnSystemPrompt = `${state._systemPrompt}\n\n---\n\n${AGENT_DIRECTIVE}`;

      // Set up abort controller for this exchange
      const abortCtrl = new AbortController();
      activeAbort     = abortCtrl;

      // 위험 작업 전 사용자 확인 함수 (rl은 이 시점에 idle 상태)
      const confirm = (msg) => new Promise((res) => {
        rl.question(
          `\n  ${chalk.yellow('⚠')}  ${msg}\n  ${chalk.dim('계속하려면 y, 취소하려면 Enter: ')}`,
          (ans) => res(ans.trim().toLowerCase() === 'y'),
        );
      });

      try {
        await runAgentLoop(state, turnSystemPrompt, abortCtrl.signal, confirm, permAskFn);

        // ── 자기검증 2차 패스 (근거 주입된 턴만) ──────────────────────────
        if (!abortCtrl.signal.aborted && state._lastGrounding) {
          const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content) {
            const stopSpin = startSpinner('자기검증 중…');
            let vres;
            try {
              vres = await verifyAnswer(state, { answer: lastAssistant.content, signal: abortCtrl.signal });
            } finally {
              stopSpin();
            }
            presentVerification(state, vres);
          }
        }

        // ── 실행검증: 답변의 코드/명령을 격리 샌드박스에서 실제 실행(opt-in) ──────
        if (!abortCtrl.signal.aborted && execVerifyEnabled()) {
          const lastAssistant = [...state.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content) {
            const stopSpin = startSpinner('실행검증 중…');
            let xres;
            try {
              xres = await runExecVerification(state, { answer: lastAssistant.content });
            } finally {
              stopSpin();
            }
            presentExecVerification(xres);
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') printError(err.message);
      } finally {
        activeAbort = null;
      }

      // ── Post-exchange housekeeping ─────────────────────────────────────
      if (!abortCtrl.signal.aborted) {
        await compactIfNeeded(state);

        // Auto-save session periodically
        if (state.messages.length % AUTO_SAVE_EVERY === 0) {
          await sessions.save(state).catch(() => {});
        }
      }

      prompt();
    });
  };

  prompt();
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgentLoop(state, systemPrompt, signal, confirm, permAskFn) {
  const maxIter = state._turnMaxIter ?? state.config?.iterations ?? DEFAULT_ITERATIONS;
  const recentContents = []; // track last N assistant contents to detect repetition

  for (let iter = 0; iter < maxIter; iter++) {

    // ── Build system content ───────────────────────────────────────────────
    let sysContent = systemPrompt ?? '';

    // 네이티브 툴콜 단일 경로. (toolMode는 session/UI 표시용 흔적 필드로만 남음.)

    // ── Inject compressed history as context ──────────────────────────────
    const messages = buildMessages(state, sysContent);

    // ── Tool list to send ──────────────────────────────────────────────────
    const sendTools = state.allTools.length > 0 ? state.allTools.map(toOllamaTool) : [];

    // ── Stream ────────────────────────────────────────────────────────────
    let fullContent     = '';
    let nativeToolCalls = [];
    let headerPrinted   = false;
    let thinkShown      = false;
    let finalStats      = null;
    const thinkFilter   = new ThinkFilter();
    const codeFilter    = new CodeBlockFilter();

    try {
      const effort = state.config?.effort ?? 'normal';
      const ollamaOptions = {
        num_ctx: state.contextLength ?? DEFAULT_NUM_CTX,
        // 생성 상한(폭주 방지). 7B가 반복루프에 빠져 수만 토큰을 무한생성하는 사고 차단.
        // env OH_NUM_PREDICT(기본 4096), 0/음수면 무제한(ollama 기본).
        num_predict: (() => { const n = parseInt(process.env.OH_NUM_PREDICT ?? '4096', 10); return Number.isFinite(n) && n > 0 ? n : -1; })(),
        ...(state.config?.temperature != null ? { temperature: state.config.temperature } : {}),
        ...(state.config?.top_p       != null ? { top_p:       state.config.top_p }       : {}),
        // think: true/false only sent when effort explicitly requires it
        ...(effort === 'off' || effort === 'low'  ? { think: false } : {}),
        ...(effort === 'high' || effort === 'max' ? { think: true  } : {}),
      };

      // For 'max' effort, prepend a strong thinking directive to the system prompt
      let effectiveMessages = messages;
      if (effort === 'max') {
        const hint = { role: 'system', content: '답변 전에 문제를 단계별로 충분히 생각하고, 여러 가능성을 검토한 뒤 최선의 답을 제시하세요.' };
        const hasSystem = messages[0]?.role === 'system';
        effectiveMessages = hasSystem
          ? [{ ...messages[0], content: `${messages[0].content}\n\n${hint.content}` }, ...messages.slice(1)]
          : [hint, ...messages];
      }

      for await (const chunk of streamChat({ model: state.model, messages: effectiveMessages, tools: sendTools, signal, options: ollamaOptions })) {
        if (chunk.done) { finalStats = chunk; continue; }

        const msg = chunk.message;
        if (!msg) continue;

        if (msg.content) {
          // Always store raw content (including <think> blocks) in history
          fullContent += msg.content;

          // Filter think blocks, then code blocks
          const { display: thinkDisplay, enteredThink, exitedThink, elapsedMs } = thinkFilter.push(msg.content);

          if (enteredThink && !thinkShown) {
            thinkShown = true;
            printThinkingStart();
          }
          if (exitedThink) {
            printThinkingEnd(elapsedMs ?? 0);
          }

          if (thinkDisplay) {
            const { display: codeDisplay, blocks } = codeFilter.push(thinkDisplay);
            if (codeDisplay) {
              if (!headerPrinted) { printAssistantLabel(); headerPrinted = true; }
              printToken(codeDisplay);
            }
            for (const { lang, code } of blocks) {
              if (!headerPrinted) { printAssistantLabel(); headerPrinted = true; }
              process.stdout.write('\n');
              printCodeBlock(lang, code);
            }
          }
        }

        if (msg.tool_calls?.length > 0) nativeToolCalls = msg.tool_calls;
      }

      // Flush any buffered partial-tag content
      const thinkTail = thinkFilter.flush();
      const { display: tailDisplay, blocks: tailBlocks } = codeFilter.flush();
      const tail = (thinkTail || '') + (tailDisplay || '');
      if (tail) {
        if (!headerPrinted) { printAssistantLabel(); headerPrinted = true; }
        printToken(tail);
      }
      for (const { lang, code } of tailBlocks) {
        if (!headerPrinted) { printAssistantLabel(); headerPrinted = true; }
        process.stdout.write('\n');
        printCodeBlock(lang, code);
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        if (headerPrinted || thinkShown) process.stdout.write('\n');
        printSystem('Cancelled.  (Ctrl+C again to exit)');
        throw err;
      }
      // 네이티브 툴 미지원 모델 → 단일 모델 전제에선 폴백이 없으므로 명확히 안내하고 중단.
      if (err.message?.includes('does not support tools') || err.message?.includes('tool_calls') ||
          err.message?.includes('tool call')) {
        printError(`이 모델(${state.model})은 네이티브 툴 호출을 지원하지 않습니다. 툴을 쓰려면 qwen3:14b 등 툴 지원 모델로 전환하세요 (/model).`);
        return;
      }
      throw err;
    }

    if (headerPrinted) process.stdout.write('\n');
    if (finalStats?.eval_count) printTokenCount(finalStats.eval_count, finalStats.eval_duration);

    // ── Repetition guard: break if model outputs identical content twice ──────
    const contentKey = fullContent.trim().slice(0, 300);
    if (contentKey && recentContents.includes(contentKey)) {
      printSystem('루프 반복 감지 — 동일한 응답이 반복되어 중단합니다.');
      state.messages.push({ role: 'assistant', content: fullContent });
      return;
    }
    recentContents.push(contentKey);
    if (recentContents.length > 3) recentContents.shift();

    // ── Native tool calls ──────────────────────────────────────────────────
    if (nativeToolCalls.length > 0) {
      if (state.toolMode === 'auto') state.toolMode = 'native';

      state.messages.push({
        role: 'assistant', content: fullContent || null, tool_calls: nativeToolCalls,
      });

      let nativeDenied = false;
      for (const tc of nativeToolCalls) {
        const fn     = tc.function ?? tc;
        const name   = fn.name;
        const params = parseArgs(fn.arguments);

        printToolUse(name, params);
        const result    = await dispatchTool(name, params, state, confirm, permAskFn);
        printRichResult(name, params, result);
        if (result._denied) { nativeDenied = true; break; }
        state.messages.push({ role: 'tool', content: JSON.stringify(result) });
      }
      if (nativeDenied) return;
      continue;
    }

    // 네이티브 툴콜이 없으면 모델이 최종 답변을 낸 것 → 종료.
    // (qwen3는 측정상 툴콜을 100% 네이티브로 내보냄. xml/json 폴백 경로는 제거됨.)

    // ── Plain response — done ──────────────────────────────────────────────
    if (!headerPrinted) { printAssistantLabel(); process.stdout.write('\n'); }
    state.messages.push({ role: 'assistant', content: fullContent });
    return;
  }

  printSystem(`Reached tool iteration limit (${maxIter}). /config iterations <숫자> 로 늘릴 수 있습니다.`);
}

// ─── Intelligent compaction ───────────────────────────────────────────────────
// When the message list grows past COMPACT_THRESHOLD:
//   1. Keep the most recent COMPACT_KEEP_RECENT messages verbatim.
//   2. Ask the model to summarize everything older.
//   3. Append that summary to state.compressedHistory.
//   4. Replace old messages with a brief context-handoff pair.
//   5. Also persist the summary to MEMORY.md.

async function compactIfNeeded(state) {
  if (state.messages.length < compactThreshold(state.contextLength)) return;

  const older  = state.messages.slice(0, -COMPACT_KEEP_RECENT);
  const recent = state.messages.slice(-COMPACT_KEEP_RECENT);

  printSystem('Compacting conversation history…');

  try {
    const req = [
      ...older,
      {
        role: 'user',
        content:
          '위 대화를 한국어로 요약해줘. 반드시 포함할 것:\n' +
          '- 생성/수정한 파일과 주요 변경 내용\n' +
          '- 결정된 사항과 그 이유\n' +
          '- 웹 검색으로 확인된 핵심 사실 (URL, 버전, 수치 등 구체적 정보 보존)\n' +
          '- 미완료 작업\n' +
          '마크다운 bullet로, 최대 300단어. 반드시 한국어로만 작성.',
      },
    ];

    let summary = '';
    for await (const chunk of streamChat({ model: state.model, messages: req, tools: [] })) {
      if (chunk.message?.content) summary += chunk.message.content;
    }

    if (!summary.trim()) return;

    // Accumulate compressed history
    state.compressedHistory = state.compressedHistory
      ? state.compressedHistory + '\n\n---\n\n' + summary.trim()
      : summary.trim();

    // Rebuild messages: lightweight context pair + recent
    state.messages = [
      { role: 'user',      content: `[이전 대화 요약 — 아래 내용을 기억하고 대화를 이어갈 것]\n${state.compressedHistory}` },
      { role: 'assistant', content: '이전 대화 내용을 파악했습니다. 계속 진행하겠습니다.' },
      ...recent,
    ];

    await state.memory.appendMemory(summary.trim()).catch(() => {});
    printSystem(`Compacted. ${older.length} messages → summary. ${recent.length} recent messages kept.`);
  } catch {
    // Non-fatal
  }
}

// ─── Auto-summarize on exit ───────────────────────────────────────────────────

async function autoSummarize(state) {
  const substantive = state.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (substantive.length < 4) return;

  try {
    const req = [
      ...state.messages,
      {
        role: 'user',
        content:
          '이 대화를 한국어로 간략히 요약해줘. 수정한 파일, 결정 사항, 미완료 작업. ' +
          '최대 200단어. 마크다운 bullet. 반드시 한국어로만 작성.',
      },
    ];

    let summary = '';
    for await (const chunk of streamChat({ model: state.model, messages: req, tools: [] })) {
      if (chunk.message?.content) summary += chunk.message.content;
    }

    if (summary.trim()) await state.memory.appendMemory(summary.trim());
  } catch { /* non-fatal */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the message array to send to Ollama.
 * Compressed history is injected as the first exchange so the model always
 * has full context without inflating the live message list.
 */
function buildMessages(state, sysContent) {
  const sysMsg = sysContent ? [{ role: 'system', content: sysContent }] : [];

  // If there's accumulated compressed history but it's NOT already the first
  // message in state.messages (compaction injects it there), prepend it now.
  // This handles the resume-from-session case where compressedHistory exists
  // but the injected pair may not be present.
  const hasInjected = state.messages[0]?.content?.startsWith('[이전 대화 요약');
  const historyPair = state.compressedHistory && !hasInjected
    ? [
        { role: 'user',      content: `[이전 대화 요약 — 아래 내용을 기억하고 대화를 이어갈 것]\n${state.compressedHistory}` },
        { role: 'assistant', content: '이전 대화 내용을 파악했습니다. 계속 진행하겠습니다.' },
      ]
    : [];

  return [...sysMsg, ...historyPair, ...state.messages];
}

/** Strip internal OH metadata before sending tool defs to Ollama. */
function toOllamaTool({ _mcp, ...clean }) { return clean; }

/**
 * Parse tool arguments.
 * Local models sometimes produce malformed JSON — single quotes, trailing
 * commas, unquoted keys, or extra text. This tries several fixes before
 * giving up and returning {}.
 */
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;

  // 1. Standard parse
  try { return JSON.parse(raw); } catch { /* continue */ }

  // 2. Extract JSON object/array substring (model may prefix with text)
  const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
  }

  // 3. Common fixes: single→double quotes, trailing commas, unquoted keys
  try {
    const fixed = raw
      .replace(/'/g, '"')                         // single quotes
      .replace(/,\s*([}\]])/g, '$1')              // trailing commas
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'); // unquoted keys
    return JSON.parse(fixed);
  } catch { /* continue */ }

  // 4. Give up — return empty (tool will get empty params, model can retry)
  return {};
}

/** Route a tool call to MCP client, plugin, or built-in. Shows a spinner for slow tools. */
async function dispatchTool(name, params, state, confirm, permAskFn) {
  // ── Permission check ──────────────────────────────────────────────────────
  if (permAskFn && state.permissions) {
    const allowed = await state.permissions.request(name, params, permAskFn);
    if (!allowed) return { _denied: true, error: '사용자가 거부했습니다.' };
  }

  // ── delete_directory: 내용물 있으면 사용자 확인 ──────────────────────────
  if (name === 'delete_directory' && confirm) {
    const target = resolve(process.cwd(), params.path ?? '');
    let entries = [];
    try { entries = await readdir(target); } catch { /* 존재 안 하면 툴에서 처리 */ }

    if (entries.length > 0) {
      process.stdout.write('\n'); // 스피너 시작 전 줄바꿈
      const ok = await confirm(
        `"${params.path}" 폴더에 ${entries.length}개 항목이 있습니다. 전부 삭제하시겠습니까?`,
      );
      if (!ok) {
        return { error: '사용자가 삭제를 취소했습니다.' };
      }
      // 확인했으면 recursive 강제 활성화
      params = { ...params, recursive: true };
    }
  }

  const stopSpin = startSpinner(spinnerLabel(name, params));
  let result;
  try {
    const mcpTool = state.allTools.find((t) => t.function?.name === name && t._mcp);
    result = mcpTool
      ? await mcpTool._mcp.client.callTool(mcpTool._mcp.originalName, params)
      : await executeTool(name, params, state.plugins, state.backup);
  } catch (err) {
    return { error: err.message };
  } finally {
    stopSpin();
  }

  return result;
}

/**
 * Rich result display — replaces the plain printToolResult for known tools.
 * Shows diffs for edits, styled output for commands, plain for the rest.
 */
function printRichResult(name, params, result) {
  if (result.error) {
    printToolResult(false, result.error);
    return;
  }

  switch (name) {
    case 'edit_file': {
      const oldStr = result.old_content ?? params.old_string;
      if (oldStr != null && params.new_string != null) {
        printEditDiff(params.path, oldStr, params.new_string);
      } else {
        printToolResult(true, result.message ?? 'Edited');
      }
      break;
    }

    case 'write_file':
      if (params.content != null) {
        printWriteSummary(params.path, params.content);
      } else {
        printToolResult(true, result.message ?? 'Written');
      }
      break;

    case 'run_command':
      printCommandOutput(params.command, result);
      break;

    case 'run_code':
      printCommandOutput(`${params.language}: ${(params.code ?? '').split('\n')[0].slice(0, 50)}`, result);
      break;

    case 'web_fetch':
      printToolResult(true,
        `${String(params.url ?? '').slice(0, 60)}  ${chalk.dim(`(${(result.length ?? 0).toLocaleString()} chars)`)}`
      );
      break;

    case 'web_search':
      if (result.results?.length > 0) {
        for (const r of result.results) {
          console.log(`    ${chalk.cyan('→')} ${r.title}`);
          console.log(`       ${chalk.dim(r.url.slice(0, 80))}`);
        }
      } else {
        printToolResult(false, '결과 없음');
      }
      break;

    case 'web_research':
      if (result.source_count > 0) {
        printToolResult(true, `"${(params.topic ?? '').slice(0, 50)}" — ${result.source_count}개 소스 수집`);
      } else if (result.error) {
        printToolResult(false, result.error.slice(0, 100));
      } else {
        printToolResult(false, '결과 없음');
      }
      break;

    case 'http_request':
      printHttpResult(params, result);
      break;

    default:
      printToolResult(true, result.message ?? result.content ?? JSON.stringify(result).slice(0, 120));
  }
}

function printHttpResult(params, result) {
  const col = 70;
  const bar = chalk.dim('  ' + '─'.repeat(col));
  const method = (params.method ?? 'GET').toUpperCase();
  const url    = String(params.url ?? '');

  const statusColor = result.status >= 500 ? chalk.red
    : result.status >= 400 ? chalk.yellow
    : result.status >= 300 ? chalk.cyan
    : chalk.green;

  console.log(`\n  ${chalk.bold.magenta(' http ')}  ${chalk.white(method)} ${chalk.dim(url.length > 55 ? '…' + url.slice(-54) : url)}`);
  console.log(bar);

  if (result.status) {
    console.log(`  ${statusColor(`${result.status} ${result.statusText}`)}`);
  }

  const ct = result.headers?.['content-type'] ?? '';
  if (ct) console.log(chalk.dim(`  Content-Type: ${ct.split(';')[0]}`));

  if (result.body?.trim()) {
    const lines = result.body.trimEnd().split('\n').slice(0, 40);
    console.log(bar);
    for (const line of lines) console.log(chalk.dim(`  ${line}`));
    if (result.body.split('\n').length > 40) {
      console.log(chalk.dim(`  … (${result.body.split('\n').length - 40} more lines)`));
    }
  }

  console.log(bar);
}

function spinnerLabel(name, params) {
  switch (name) {
    case 'run_command':  return `$ ${String(params.command ?? '').slice(0, 55)}`;
    case 'run_code':     return `running ${params.language ?? 'code'}…`;
    case 'web_search':   return `searching: ${String(params.query ?? '').slice(0, 45)}`;
    case 'web_fetch':    return `fetching: ${String(params.url ?? '').slice(0, 50)}`;
    case 'http_request': return `${(params.method ?? 'GET').toUpperCase()} ${String(params.url ?? '').slice(0, 50)}`;
    case 'search_files': return `searching files for "${String(params.pattern ?? '').slice(0, 30)}"`;
    case 'find_files':   return `finding ${params.pattern ?? 'files'}…`;
    case 'read_file':    return `reading ${String(params.path ?? '').slice(0, 50)}`;
    case 'write_file':   return `writing ${String(params.path ?? '').slice(0, 50)}`;
    case 'edit_file':    return `editing ${String(params.path ?? '').slice(0, 50)}`;
    default:             return `${name}…`;
  }
}

// ─── Model selection ──────────────────────────────────────────────────────────
// Shows an interactive numbered list of installed Ollama models.
// Returns the chosen model name.

async function promptSelectModel(defaultModel) {
  let models;
  try {
    models = await listModels();
  } catch {
    return defaultModel; // Ollama unavailable — will fail in ping() anyway
  }

  if (models.length === 0) {
    console.log(chalk.dim('\n  No models installed. Run: ollama pull <model>\n'));
    return defaultModel;
  }

  // If there's only one model, just use it silently
  if (models.length === 1) return models[0].name;

  // Display list
  console.log(`\n${chalk.bold('  Available models')}\n`);
  models.forEach((m, i) => {
    const gb      = m.size ? chalk.dim(` ${(m.size / 1e9).toFixed(1)} GB`) : '';
    const isEnv   = m.name === defaultModel;
    const marker  = isEnv ? chalk.green(' ←') : '';
    const idx     = chalk.cyan(`  [${i + 1}]`);
    console.log(`${idx}  ${m.name}${gb}${marker}`);
  });
  console.log();

  // Default index: whichever matches OH_MODEL / DEFAULT_MODEL, else 1
  const defaultIdx = Math.max(0, models.findIndex((m) => m.name === defaultModel));

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(
      chalk.dim(`  Select [1-${models.length}] or model name`) +
      chalk.dim(` (Enter = ${models[defaultIdx].name}): `),
      (ans) => {
        rl.close();
        const trimmed = ans.trim();

        if (!trimmed) { resolve(models[defaultIdx].name); return; }

        // Number input
        const n = parseInt(trimmed, 10);
        if (!isNaN(n) && n >= 1 && n <= models.length) {
          resolve(models[n - 1].name);
          return;
        }

        // Model name typed directly — warn if not found
        const found = models.find((m) => m.name === trimmed || m.name.startsWith(trimmed));
        if (!found) console.log(chalk.yellow(`\n  ⚠ 목록에 없는 모델: ${trimmed} — 계속 진행합니다.`));
        resolve(found ? found.name : trimmed);
      },
    );
  });
}

// ─── Auto search injection ────────────────────────────────────────────────────
// When the user's message clearly signals a search intent but the previous
// assistant turn didn't call any tool, OH runs the search itself and injects
// the result as a synthetic tool exchange so the model always has real data.

// Matches search trigger verbs — capture group 1 = text before trigger, group 3 = instructions after
const SEARCH_TRIGGER_RE = /^([\s\S]*?)\s*(검색해|찾아봐|조사해|알아봐|검색 시작해|웹에서 찾아|인터넷에서 찾아|search for|look up|research)([\s\S]*)$/i;

// Patterns like "X는 제외하고", "X 빼고", "X 제외", "exclude X", "without X"
const EXCLUDE_RE = /([가-힣\w]+(?:\s[가-힣\w]+){0,2})(?:는|은|을|를)?\s*(?:제외하고|제외|빼고|빼줘|빼)|(?:exclude|without|not)\s+([가-힣\w]+(?:\s[가-힣\w]+){0,2})/gi;

/**
 * Parse instruction text after the trigger verb for search modifiers.
 * Returns { excludes: string[] } — terms to add as -term to the query.
 */
function parseSearchModifiers(instruction) {
  const excludes = [];
  let m;
  const re = new RegExp(EXCLUDE_RE.source, 'gi');
  while ((m = re.exec(instruction)) !== null) {
    const term = (m[1] ?? m[2] ?? '').trim();
    if (term) excludes.push(term);
  }
  return { excludes };
}

// ─── 의도 기반 지식 근거 확보 (RAG 먼저 → KB 없으면 신뢰소스/웹 자동 폴백) ──────
// 키워드 트리거가 아니라 "요청 의도 파악 → 지식DB에 없으면 검색" 플로우.
async function autoGround(state, userText) {
  state._lastGrounding = null;   // 이번 턴 근거 초기화 (검증 패스 게이트)
  const text = userText?.trim();
  if (!text || text.length < 4) return;   // 인사·단답 스킵

  // 이번 유저 턴에 이미 툴 결과가 붙었으면 스킵
  const msgs = state.messages;
  const lastToolIdx = [...msgs].reverse().findIndex(m => m.role === 'tool');
  const lastUserIdx = [...msgs].reverse().findIndex(m => m.role === 'user');
  if (lastToolIdx !== -1 && lastToolIdx < lastUserIdx) return;

  // 1) 지식DB(RAG) 먼저 — 충족되면 외부검색 안 함
  if (await autoInjectRag(state, text)) return;

  // 2) KB 미스 → 의도 파악 후 신뢰소스 자동 폴백
  const forced = SEARCH_TRIGGER_RE.test(text);
  const cve    = (text.match(/CVE-\d{4}-\d{4,}/i) ?? [])[0];

  // 2a) CVE → NVD/MITRE 공식 커넥터 (의도 명확)
  if (cve) { await injectCveLookup(state, cve.toUpperCase()); return; }

  // 2b) ATT&CK 기법번호(T####) → MITRE ATT&CK 공식 커넥터
  const tech = (text.match(/\bT\d{4}(?:\.\d{3})?\b/i) ?? [])[0];
  if (tech) { await injectAttackLookup(state, tech.toUpperCase()); return; }

  // 2c) 그 외: 명시 검색요청이거나 정보탐색 의문문일 때만 웹 폴백 (코딩·파일작업 제외)
  if (!forced && !isInfoSeeking(text)) return;

  // 명시 트리거면 기존 파싱으로 query 정제, 아니면 전체 텍스트
  let query = text.slice(0, 200);
  const m = SEARCH_TRIGGER_RE.exec(text);
  if (m) {
    const topic = m[1].replace(/[^\w\s가-힣]/g, ' ').trim().slice(0, 200);
    if (topic && topic.length >= 2) {
      const { excludes } = parseSearchModifiers((m[3] ?? '').trim());
      query = excludes.length > 0 ? `${topic} ${excludes.map(e => `-${e}`).join(' ')}` : topic;
    }
  }
  await runWebResearch(state, query);
}

// 정보탐색 의도 휴리스틱: 의문문/사실요청인가. 코딩·파일조작 명령은 웹검색 대상에서 제외.
function isInfoSeeking(text) {
  if (/(작성해|만들어|구현|수정해|고쳐|리팩|실행해|설치해|커밋|디버그|이 파일|디렉터리)/.test(text)) return false;
  if (/[?？]/.test(text)) return true;
  return /(무엇|뭐|뭔|어떻게|어케|왜|언제|어디|누구|누가|얼마|몇|뜻|의미|차이|개념|원리|방법|정의|알려|설명|정리|조사|찾아)/.test(text);
}

// 공식 CVE 조회 결과를 주입 (tier1: NVD/MITRE + KEV/EPSS/GHSA 종합).
async function injectCveLookup(state, cveId) {
  process.stderr.write(`\r  🛡  공식 CVE 조회: ${cveId}...\n`);
  try {
    const { executeTool } = await import('./tools.js');
    const r = await executeTool('cve_lookup', { cve_id: cveId });
    if (r.error || r.found === false) return;
    const cv = r.cvss ? `${r.cvss.score} ${r.cvss.severity} (${r.cvss.vector})` : '미평가';
    const epss = r.epss ? `${(r.epss.probability * 100).toFixed(1)}% (상위 ${(r.epss.percentile * 100).toFixed(0)}%)` : '미상';
    const kev = r.exploited ? `예 (CISA KEV${r.exploited.ransomware === 'Known' ? ', 랜섬웨어 확인' : ''})` : '미확인';
    const aff = r.ghsa?.affected?.length
      ? r.ghsa.affected.map(a => `${a.ecosystem}:${a.package} ${a.range}→${a.patched ?? '미패치'}`).join('; ')
      : '';
    const block =
      `${r.id} — 심각도 ${cv}\n악용확률(EPSS): ${epss} | 실제악용: ${kev}\n` +
      `상태: ${r.status} | 공개: ${r.published}\n` +
      (aff ? `영향 패키지(GHSA): ${aff}\n` : '') +
      `\n${r.description ?? ''}\n\n참고: ${r.references.join(', ')}`;
    const sanitized = block.replace(/\{/g, '｛').replace(/\}/g, '｝').slice(0, 8000);
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg?.role === 'user') {
      lastMsg.content =
        `[공식 CVE 데이터 — ${r.id} (출처: ${r.source}, 신뢰등급: 공식)]\n` +
        `🚫 아래 공식 데이터에만 기반해 답하고, 출처를 "${r.source}"로 밝힐 것. 추측 금지.\n` +
        `⚠️ 반드시 한국어로 답변.\n\n${sanitized}\n\n---\n\n` + lastMsg.content;
    }
    state._lastGrounding = { kind: `CVE(${r.source})`, query: cveId, context: sanitized };
    process.stderr.write(`\r  ✓ 공식 CVE 데이터 주입 (${r.id} — ${r.source})          \n`);
  } catch { /* 비치명적 */ }
}

// MITRE ATT&CK 기법 조회 결과를 주입 (tier1 신뢰소스).
async function injectAttackLookup(state, tech) {
  process.stderr.write(`\r  🎯 MITRE ATT&CK 조회: ${tech}...\n`);
  try {
    const { executeTool } = await import('./tools.js');
    const r = await executeTool('attack_lookup', { query: tech });
    if (r.error || r.found === false) return;
    const block =
      `${r.id} ${r.name}\n전술: ${r.tactics.join(', ')} | 플랫폼: ${r.platforms.join(', ')}\n\n` +
      `${r.description}\n\n탐지: ${r.detection ?? ''}\n참고: ${r.url}`;
    const sanitized = block.replace(/\{/g, '｛').replace(/\}/g, '｝').slice(0, 8000);
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg?.role === 'user') {
      lastMsg.content =
        `[MITRE ATT&CK 공식 — ${r.id} (출처 신뢰등급: 공식)]\n` +
        `🚫 아래 공식 데이터에만 기반해 답하고, 출처를 "MITRE ATT&CK(공식)"으로 밝힐 것. 추측 금지.\n` +
        `⚠️ 반드시 한국어로 답변.\n\n${sanitized}\n\n---\n\n` + lastMsg.content;
    }
    state._lastGrounding = { kind: 'ATT&CK(공식)', query: tech, context: sanitized };
    process.stderr.write(`\r  ✓ ATT&CK 공식 데이터 주입 (${r.id})          \n`);
  } catch { /* 비치명적 */ }
}

async function runWebResearch(state, query) {
  process.stderr.write(`\r  🔍 자동 검색: "${query.slice(0, 60)}"...\n`);

  try {
    const { executeTool } = await import('./tools.js');

    // web_research: runs multiple queries, cross-references results (pages appearing
    // in multiple queries rank higher), fetches top pages — same approach as Claude Code.
    const maxSources = state.config?.search_results ?? 5;
    const res = await executeTool('web_research', { topic: query, max_sources: maxSources });
    if (res.error || !res.summary) return;

    // Show sources
    if (res.source_count) {
      process.stdout.write(`\n  ${chalk.dim(`소스 ${res.source_count}개 확인`)}\n\n`);
    }

    // Sanitize: replace { } to avoid Ollama's buggy JSON parser treating them as objects
    const sanitized = res.summary
      .replace(/\{/g, '｛')
      .replace(/\}/g, '｝')
      .slice(0, 10000);

    // Download images found in search result pages (for vision-capable models)
    let images;
    if (res.imageUrls?.length > 0) {
      process.stderr.write(`\r  🖼  이미지 ${res.imageUrls.length}개 다운로드 중...\n`);
      const downloaded = await Promise.all(
        res.imageUrls.slice(0, 4).map(async (imgUrl) => {
          try {
            const r = await fetch(imgUrl, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) return null;
            const buf = await r.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            if (b64.length > 500) return b64; // skip empty/tiny
            return null;
          } catch { return null; }
        })
      );
      images = downloaded.filter(Boolean);
      if (images.length > 0) {
        process.stderr.write(`\r  ✓ 이미지 ${images.length}개 첨부 (비전 모델에서 읽힘)          \n`);
      }
    }

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg?.role === 'user') {
      lastMsg.content =
        `[웹 검색 결과 — "${query}"]\n` +
        `⚠️ 언어 규칙: 아래 내용이 영어여도 반드시 한국어로만 답변할 것. 영어 답변 절대 금지.\n` +
        `🚫 아래 소스에 없는 내용은 절대 언급하지 말 것. 학습 데이터·메모리·추측으로 보완 금지. 소스에 없으면 "검색 결과에 없음"이라고 말할 것.\n` +
        `🚫 날짜·수치·회사명은 반드시 아래 소스에서 직접 인용할 것. 임의로 만들어내지 말 것.\n` +
        `✅ 이 검색 결과는 이후 대화에서도 계속 참고할 수 있도록 핵심 내용을 기억할 것.\n\n` +
        `${sanitized}\n\n---\n\n` +
        lastMsg.content;
      // Attach images for vision-capable models (Ollama ignores if model doesn't support vision)
      if (images?.length > 0) lastMsg.images = images;
    }
    state._lastGrounding = { kind: '웹검색(일반)', query, context: sanitized };

    process.stderr.write(`\r  ✓ 검색 완료 (${res.source_count}개 소스 주입)          \n`);

    // 휘발 방지: 웹 검색 결과를 RAG에 영구 저장(tier3=일반, 수집날짜 태그).
    // source 키를 질의로 → 같은 주제 재검색 시 갱신(중복 누적 X). 다음부터는 KB에서 바로 나옴.
    try {
      const { addDocument, TIER } = await import('./rag.js');
      const date = new Date().toISOString().slice(0, 10);
      const text =
        `# 웹 검색 캐시: ${query}\n` +
        `수집일: ${date} | 출처: 웹(신뢰등급 일반, 재검증 권장)\n\n` +
        res.summary.slice(0, 12000);
      await addDocument({ source: `web:${query}`, title: `웹: ${query} (${date})`, text, tier: TIER.GENERAL });
      process.stderr.write(`\r  💾 검색 결과 KB 저장됨 (web:${query.slice(0, 40)})          \n`);
    } catch { /* 저장 실패는 비치명적 */ }
  } catch {
    // Non-fatal: if search fails, let the model try on its own
  }
}

// 로컬 지식베이스(RAG)에서 관련 근거를 찾아 자동 주입한다.
// 매 유저 턴에 검색하되, 관련도(코사인)가 임계값을 넘는 청크만 주입 → 무관한 턴엔 침묵.
// 웹 검색과 달리 명시 트리거가 필요 없다(로컬 KB는 비용·노출 없음). 우선순위: RAG → web.
// 관련도 게이트(코사인 0.5 / 키워드매치 0.35)는 rag.js searchHybrid 내부에 있음.
// topK(주입 청크 수). Phase5 검색평가 실측: k3→k5에서 Recall 88%→94%(비용 거의 0).
// OH_RAG_TOPK 로 조정, 기본 5.
const RAG_MAX_CHUNKS = Math.max(1, parseInt(process.env.OH_RAG_TOPK ?? '5', 10) || 5);

// 멀티쿼리 확장: 한 질문을 여러 각도 쿼리로 분해해 RAG 검색 다양성을 높인다(넓은 사고).
// 기본 on. OH_MULTIQUERY_N 으로 추가 각도 쿼리 수 조절(기본 2, 0이면 비활성과 동일).
const MULTIQUERY     = (process.env.OH_MULTIQUERY ?? 'on').toLowerCase() !== 'off';
const MULTIQUERY_MAX = Math.max(0, parseInt(process.env.OH_MULTIQUERY_N ?? '2', 10) || 0);

// 한 질문을 서로 다른 각도의 검색 쿼리로 확장한다(모델 1회 호출, 저비용).
// 실패/빈결과면 빈 배열 → 호출자는 원 질문만 사용.
async function expandQueries(state, topic) {
  if (!MULTIQUERY || MULTIQUERY_MAX === 0) return [];
  const prompt =
    `다음 질문을 지식베이스에서 더 잘 찾기 위한 "서로 다른 각도"의 검색 쿼리 ${MULTIQUERY_MAX}개로 바꿔라.\n` +
    `- 동의어·상위개념·구체기법·영문 보안용어를 활용해 서로 겹치지 않게.\n` +
    `- 설명·번호·기호 없이, 한 줄에 쿼리 하나씩만 출력.\n\n질문: ${topic}`;
  try {
    let out = '';
    for await (const chunk of streamChat({
      model: state.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      options: { temperature: 0.3, top_p: 0.9, num_predict: 120, think: false, num_ctx: state.contextLength ?? DEFAULT_NUM_CTX },
    })) {
      if (chunk.message?.content) out += chunk.message.content;
    }
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '');
    const lines = out.split('\n')
      .map(l => l.replace(/^[\s\-*•0-9.)\]】"']+/, '').replace(/["']+$/, '').trim())
      .filter(l => l.length >= 2 && l.length <= 200 && l.toLowerCase() !== topic.toLowerCase());
    return [...new Set(lines)].slice(0, MULTIQUERY_MAX);
  } catch {
    return [];
  }
}

// 로컬 지식베이스에서 근거를 찾아 주입. 주입했으면 true(→ 외부검색 생략).
async function autoInjectRag(state, topic) {
  const TIER_LABEL = { 1: '공식', 2: '커뮤니티', 3: '일반' };
  try {
    const { searchHybrid, searchMulti, stats } = await import('./rag.js');
    if (stats().chunks === 0) return false;   // KB 비었으면 조용히 패스

    // 멀티쿼리 확장(넓은 사고) → 여러 각도로 검색 후 원 질문 기준 재채점. 확장 실패 시 단일 검색.
    const extra = await expandQueries(state, topic);
    if (extra.length) process.stderr.write(`\r  🧭 멀티쿼리 ${extra.length + 1}각도 검색…          \n`);
    const hits = extra.length
      ? await searchMulti([topic, ...extra], { topK: RAG_MAX_CHUNKS, primary: topic })
      : await searchHybrid(topic, { topK: RAG_MAX_CHUNKS });
    if (hits.length === 0) return false;

    const blocks = hits.map((h, i) => {
      const cite = h.heading ? `${h.source} › ${h.heading}` : h.source;
      return `[근거 ${i + 1}] (출처: ${cite}, 신뢰등급: ${TIER_LABEL[h.tier] ?? '일반'})\n${h.body}`;
    }).join('\n\n');

    // Ollama JSON 파서 버그 회피: { } 치환
    const sanitized = blocks.replace(/\{/g, '｛').replace(/\}/g, '｝').slice(0, 10000);

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg?.role === 'user') {
      lastMsg.content =
        `[지식베이스 근거 — "${topic.slice(0, 60)}"]\n` +
        `🚫 아래 근거에 있는 내용만 사용할 것. 학습데이터·추측으로 보완 금지. 근거에 없으면 "지식베이스에 없음"이라고 명시할 것.\n` +
        `✅ 답변에 사용한 근거의 출처(문서명›섹션)와 신뢰등급을 함께 밝힐 것. 공식>커뮤니티>일반 순으로 신뢰.\n` +
        `⚠️ 반드시 한국어로 답변.\n\n` +
        `${sanitized}\n\n---\n\n` +
        lastMsg.content;
    }
    state._lastGrounding = { kind: 'KB', query: topic, context: sanitized };
    process.stderr.write(`\r  📚 KB 근거 ${hits.length}개 주입 (최고 관련도 ${hits[0].score.toFixed(2)})          \n`);
    return true;
  } catch {
    return false;   // 비치명적: RAG 실패 시 모델이 알아서 답하도록 둔다
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.log('\n  Fatal:', err.message ?? err);
  process.exit(1);
});
