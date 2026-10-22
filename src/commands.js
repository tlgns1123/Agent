import chalk    from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative, extname } from 'path';
import {
  printSystem, printInfo, printError,
  printAssistantLabel, printToken, printStatus,
  printCommandOutput,
} from './ui.js';
import { DEFAULT_CONVENTIONS } from './memory.js';
import {
  gatherProjectContext,
  generateAgentsMd,
  ctxToCharLimit,
  buildMemoryInit,
  buildWorkLogPrompt,
  buildAgentsUpdatePrompt,
} from './init.js';
import { streamChat, pullModel, deleteModel } from './ollama.js';
import { sandboxLabel, sandboxEnabled, sandboxDistro, checkSandbox } from './sandbox.js';
import {
  isGitRepo, getGitDiff, gitStatus, gitListBranches,
  gitCheckout, gitAdd, gitCommit, gitPush,
  githubFetchIssue, githubListIssues,
} from './git.js';

const execP = promisify(exec);

// ─── Router ───────────────────────────────────────────────────────────────────

export function isCommand(input) {
  return input.startsWith('/');
}

export async function handleCommand(input, state) {
  const parts = input.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);

  switch (cmd) {
    case '/help':     printHelp(state);               return { handled: true };
    case '/model':    await cmdModel(args, state);     return { handled: true };
    case '/memory':   await cmdMemory(args, state);    return { handled: true };
    case '/clear':
      state.messages = [];
      printSystem('Conversation cleared.');
      return { handled: true };
    case '/tools':    cmdTools(state);                 return { handled: true };
    case '/plugins':  cmdPlugins(state);               return { handled: true };
    case '/mcp':      cmdMcp(state);                   return { handled: true };
    case '/session':  await cmdSession(args, state);   return { handled: true };
    case '/init':     await cmdInit(state);            return { handled: true };
    case '/check':    await cmdCheck(args, state);     return { handled: true };
    case '/update':   await cmdUpdate(args, state);    return { handled: true };
    case '/status':   printStatus(state);              return { handled: true };
    case '/context':  await cmdContext(args, state);   return { handled: true };
    case '/config':   await cmdConfig(args, state);    return { handled: true };
    case '/effort':   cmdEffort(args, state);           return { handled: true };
    case '/search':   cmdSearch(args, state);           return { handled: true };
    case '/cd':       await cmdCd(args, state);        return { handled: true };
    case '/paste':    await cmdPaste(state);            return { handled: true };
    case '/git':      await cmdGit(args, state);        return { handled: true };
    case '/diff':     await cmdDiff(args, state);       return { handled: true };
    case '/todo':     await cmdTodo(args, state);       return { handled: true };
    case '/lint':     await cmdLint(args, state);       return { handled: true };
    case '/undo':     await cmdUndo(args, state);        return { handled: true };
    case '/watch':    await cmdWatch(args, state);      return { handled: true };
    case '/sandbox':  cmdSandbox(args, state);          return { handled: true };
    case '/verify':   cmdVerify(args, state);           return { handled: true };
    case '/rag':      await cmdRag(input, state);        return { handled: true };
    case '/exit':
    case '/quit':
      return { handled: true, exit: true };
    default:
      printSystem(`Unknown command: ${cmd}  (/help 로 전체 목록 확인)`);
      return { handled: true };
  }
}

// ─── /help ────────────────────────────────────────────────────────────────────

function h(cmd, desc) {
  return `  ${chalk.cyan(cmd.padEnd(34))}${chalk.dim(desc)}`;
}

function printHelp(state) {
  const c  = (s) => chalk.bold.white(s);
  const d  = (s) => chalk.dim(s);
  const cy = (s) => chalk.cyan(s);
  const gr = (s) => chalk.green(s);

  console.log(`
${chalk.bold.cyan('  ┌─ ooh — Ollama Helper ─────────────────────────────────────────┐')}

${c('  AGENT 사용법')}  ${d('(OpenWebUI처럼 에이전트로 사용)')}

  그냥 말하면 됩니다. 파일 읽기·수정·삭제, 명령 실행, 웹 검색까지
  AI가 자동으로 툴을 선택해서 실행합니다.

  ${gr('예시')}
  ${d('  파일 구조 보여줘')}
  ${d('  src/index.js 읽고 버그 찾아줘')}
  ${d('  git status 실행하고 변경사항 요약해줘')}
  ${d('  README.md 작성해줘')}
  ${d('  @screenshot.png 이 화면 설명해줘          ← 이미지 첨부')}
  ${d('  이 프로젝트에 새 기능 추가해줘             ← 멀티스텝 자동 실행')}

${c('  모델 관리')}
${h('/model', '설치된 모델 목록')}
${h('/model pull <name>', '모델 다운로드  (hf.co/... 허깅페이스 포함)')}
${h('/model update [name]', '모델 최신 버전으로 업데이트 (생략 시 현재 모델)')}
${h('/model update-all', '설치된 모든 모델 업데이트')}
${h('/model rm <name>', '모델 삭제')}
${h('/model <이름>', '모델 전환  (예: /model qwen2.5-coder:7b)')}

${c('  컨텍스트 / 설정')}
${h('/context', '현재 컨텍스트 설정 보기')}
${h('/context 1', '16K 토큰으로 설정')}
${h('/context 2', ' 8K 토큰으로 설정')}
${h('/context 3', '10K 토큰으로 설정')}
${h('/context reset', '모델 기본값으로 초기화')}
${h('/config', '현재 설정값 전체 보기')}
${h('/config temperature <0~2>', '응답 창의성 조절  (기본: 0.8)')}
${h('/config top_p <0~1>', '토큰 확률 범위 조절  (기본: 0.9)')}
${h('/config iterations <숫자>', '툴 최대 반복 횟수  (기본: 3)')}
${h('/config reset', '모든 설정 기본값으로')}
${h('/effort', '추론 깊이 보기  (off | low | normal | high | max)')}
${h('/effort <레벨>', '추론 깊이 변경  — think 파라미터로 모델에 전달')}
${h('/status', '현재 모델·컨텍스트·세션 정보')}

${c('  작업 디렉터리')}
${h('/cd <경로>', '작업 디렉터리 변경  (예: /cd C:\\proj\\myapp)')}
${h('/cd', '현재 작업 디렉터리 확인')}

${c('  에이전트 설정 (AGENTS.md)')}
${h('/init', '프로젝트 자동 분석 → AGENTS.md + MEMORY.md 생성')}
${h('/check', '전체 코드 버그 · 플로우 오류 · 연동 문제 분석')}
${h('/update', 'AGENTS.md + MEMORY.md 둘 다 업데이트')}
${h('/update memory', 'MEMORY.md 작업 로그만 업데이트')}
${h('/update agents', 'AGENTS.md 프로젝트 지식만 업데이트')}
${h('/memory', 'MEMORY.md 내용 보기')}
${h('/memory save <메모>', 'MEMORY.md에 메모 추가')}
${h('/memory clear', 'MEMORY.md 초기화')}

  ${d('AGENTS.md 구조:')}
  ${d('  [컨벤션 규칙]  ←  CONVENTIONS.md에서 자동 이전 or 기본값')}
  ${d('  [모델 설정]    ←  /model, /context 변경 시 자동 갱신')}
  ${d('  [프로젝트 지식] ← /init 실행 시 AI가 분석해서 작성')}

${c('  플러그인 추가')}
  ${d('프로젝트 폴더에  plugins/  디렉터리 생성 후 .js 파일 추가')}
  ${gr('예시')} ${d('plugins/mytools.js')}

  ${d(`  export const name = 'mytools';`)}
  ${d(`  export const description = '내 커스텀 툴';`)}
  ${d(`  export const tools = [{`)}
  ${d(`    type: 'function',`)}
  ${d(`    function: { name: 'my_tool', description: '...', parameters: {...} }`)}
  ${d(`  }];`)}
  ${d(`  export async function execute(toolName, params) { ... }`)}

${h('/plugins', '로드된 플러그인 목록')}

${c('  MCP 서버 연결')}
  ${d('프로젝트 폴더에  oh.config.json  생성:')}
  ${d('  { "mcpServers": { "name": { "command": "npx", "args": [...] } } }')}
${h('/mcp', '연결된 MCP 서버 목록')}

${c('  세션 관리')}
${h('/session', '저장된 세션 목록')}
${h('/session save [이름]', '현재 대화 저장')}
${h('/session load <이름>', '저장된 세션 불러오기')}
${h('/session last', '가장 최근 세션 재개')}
${h('/session new', '새 세션 시작')}
${h('/session delete <이름>', '세션 삭제')}
${h('/clear', '현재 대화 기록 삭제 (세션은 유지)')}

${c('  툴 목록')}
${h('/tools', '사용 가능한 모든 툴 보기')}

  ${d('기본 내장 툴:')}
  ${d('  📄 read_file          파일 읽기')}
  ${d('  ✏️  write_file         파일 쓰기 (새 파일 생성 포함)')}
  ${d('  ✏️  edit_file          파일 일부만 수정 (old→new 교체)')}
  ${d('  🗑  delete_file        파일 삭제')}
  ${d('  ↔️  move_file          파일/폴더 이동 or 이름 변경')}
  ${d('  📋 copy_file          파일 복사')}
  ${d('  📁 create_directory   폴더 생성')}
  ${d('  🗑  delete_directory   폴더 삭제 (recursive 옵션)')}
  ${d('  📂 list_directory     폴더 내용 보기')}
  ${d('  🔍 find_files         파일명 패턴으로 찾기 (*.js 등)')}
  ${d('  🔎 search_files       파일 내용 정규식 검색')}
  ${d('  ▶  run_command        셸 명령어 실행 (git, npm, bash 등)')}
  ${d('  ⚡ run_code           Python / Node.js / Shell 코드 실행')}
  ${d('  🌐 web_search         웹 검색 (DuckDuckGo)')}
  ${d('  🌐 web_fetch          URL 내용 가져오기')}

  ${d('파일 권한:')}
  ${d('  프로젝트 폴더 내부  → 읽기/쓰기/삭제 모두 허용')}
  ${d('  프로젝트 폴더 외부  → 읽기만 허용')}

${c('  Git / GitHub')}
${h('/git', 'git 저장소 상태 요약')}
${h('/git commit', 'AI가 diff 읽고 커밋 메시지 생성 → 확인 후 커밋')}
${h('/git commit all', '모든 변경사항 스테이징 후 AI 커밋')}
${h('/git branch', '브랜치 목록')}
${h('/git branch <이름>', '브랜치 전환')}
${h('/git branch -b <이름>', '새 브랜치 생성 후 전환')}
${h('/git push', '현재 브랜치 push')}
${h('/git issues', 'GitHub 이슈 목록 (token 필요)')}
${h('/diff', '현재 git diff 보기 + AI 리뷰')}
${h('/diff <파일>', '특정 파일 diff 보기')}

  ${d('GitHub 연동 (환경변수):')}
  ${d('  GITHUB_OWNER=myuser  GITHUB_REPO=myrepo  GITHUB_TOKEN=ghp_...')}
  ${d('  메시지에서 @#123 으로 이슈/PR 컨텍스트 자동 삽입')}

${c('  지식베이스 (RAG)')}
${h('/rag', '지식베이스 상태 / 도움말')}
${h('/rag add <파일|URL>', '보안 문서 적재 (청킹+임베딩)')}
${h('/rag add-repo <owner/repo>', 'GitHub 저장소 .md 일괄적재 (--readme --tier N --max N)')}
${h('/rag list', '적재된 문서 목록')}
${h('/rag search <질의>', '검색 테스트')}
${h('/rag remove <ID>', '문서 삭제 / /rag clear 전체삭제 / /rag reindex 재색인')}

${c('  파일 감시 / 자동 리뷰')}
${h('/watch', '파일 변경 감시 시작 (변경 시 알림)')}
${h('/watch stop', '파일 감시 중지')}

${c('  실행 격리 / 검증')}
${h('/sandbox', '격리 상태 보기 (기본: host 직접 실행)')}
${h('/sandbox on [배포판]', '위험한 실행을 WSL 안에서 (기본: kali-linux)')}
${h('/sandbox off', 'host 직접 실행으로 복귀')}
${h('/verify', '답변 2차 검증 상태 (기본 off)')}
${h('/verify on|off', '자기검증(self-critique) 토글')}
${h('/verify exec on|off', '답변 코드 샌드박스 실행검증 토글')}

${c('  코드 품질')}
${h('/todo', 'TODO / FIXME / HACK 주석 목록')}
${h('/lint', 'eslint / prettier / tsc 실행')}

${c('  되돌리기')}
${h('/undo', '마지막 파일 변경 복원 (백업에서)')}
${h('/undo list', '되돌릴 수 있는 변경 목록')}

${c('  이미지 첨부')}
  ${d('메시지에  @파일경로  포함:')}
  ${d('  이거 분석해줘 @C:\\Users\\me\\screen.png')}
  ${d('  @./diagrams/arch.png 이 구조 설명해줘')}
  ${d('  @src/  폴더 전체를 컨텍스트로 첨부 (텍스트 파일만)')}
${h('/paste', '클립보드 이미지를 다음 메시지에 첨부 (Windows)')}

${c('  CLI 실행 옵션')}
  ${d('  ooh                          기본 실행 (모델 선택)')}
  ${d('  ooh <모델명>                  바로 모델 지정')}
  ${d('  ooh --host http://IP:11434   원격 Ollama 서버 연결')}
  ${d('  ooh --session <id>           세션 재개')}

${chalk.dim(`  Model: ${state.model}  │  Context: ${state.contextLength ? (state.contextLength/1024).toFixed(0)+'K' : 'default'}  │  Effort: ${state.config?.effort ?? 'normal'}  │  Tool mode: ${state.toolMode}`)}
${chalk.bold.cyan('  └───────────────────────────────────────────────────────────────┘')}
`);
}

// ─── /model ───────────────────────────────────────────────────────────────────

async function cmdModel(args, state) {
  const sub = args[0];

  // ── /model  (list) ────────────────────────────────────────────────────────
  if (!sub || sub === 'list') {
    try {
      const models = await state.listModels();
      if (models.length === 0) {
        printSystem('설치된 모델 없음 — /model pull <이름> 으로 다운로드');
        return;
      }
      console.log(`\n${chalk.bold('  설치된 모델')}`);
      for (const m of models) {
        const active  = m.name === state.model ? chalk.green(' ← 사용 중') : '';
        const size    = m.size ? chalk.dim(` ${(m.size / 1e9).toFixed(1)} GB`) : '';
        const modified = m.modified_at ? chalk.dim(` (${m.modified_at.slice(0, 10)})`) : '';
        console.log(`    ${chalk.cyan(m.name)}${size}${modified}${active}`);
      }
      console.log();
    } catch (err) {
      printError(err.message);
    }
    return;
  }

  // ── /model pull <name>  ───────────────────────────────────────────────────
  if (sub === 'pull') {
    const name = args.slice(1).join(' ');
    if (!name) { printSystem('Usage: /model pull <model-name>'); return; }
    await runModelPull(name, state);
    return;
  }

  // ── /model update [name]  — re-pull to get latest version ─────────────────
  if (sub === 'update') {
    const name = args[1] ?? state.model;
    printSystem(`업데이트 확인: ${chalk.cyan(name)}`);
    await runModelPull(name, state);
    return;
  }

  // ── /model update-all  ────────────────────────────────────────────────────
  if (sub === 'update-all') {
    const models = await state.listModels().catch(() => []);
    if (models.length === 0) { printSystem('설치된 모델 없음'); return; }
    for (const m of models) {
      printSystem(`업데이트: ${chalk.cyan(m.name)}`);
      await runModelPull(m.name, state);
    }
    return;
  }

  // ── /model rm <name>  ─────────────────────────────────────────────────────
  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = args[1];
    if (!name) { printSystem('Usage: /model rm <model-name>'); return; }
    try {
      await deleteModel(name);
      printSystem(`삭제됨: ${chalk.cyan(name)}`);
    } catch (err) {
      printError(err.message);
    }
    return;
  }

  // ── /model <name>  (switch) ───────────────────────────────────────────────
  state.model    = sub;
  state.toolMode = 'auto';
  printSystem(`모델 전환: ${chalk.cyan(sub)}`);
  await state.memory.updateModelSection(sub, state.contextLength, state.config, state._github).catch(() => {});
}

async function runModelPull(name, state) {
  const abort = new AbortController();
  state._inModelPull = true;

  // Allow Ctrl+C to cancel the download
  const onSigint = () => { abort.abort(); };
  process.once('SIGINT', onSigint);

  let lastStatus = '';
  let lastPct    = -1;

  try {
    for await (const chunk of pullModel(name, abort.signal)) {
      const status  = chunk.status ?? '';
      const pct     = chunk.percent;

      if (pct != null) {
        if (pct !== lastPct) {
          process.stdout.write(`\r  ${chalk.cyan(name)}  ${status}  ${chalk.green(pct + '%')}   `);
          lastPct = pct;
        }
      } else if (status !== lastStatus) {
        if (lastPct >= 0) process.stdout.write('\n');
        process.stdout.write(`  ${chalk.dim(status)}\n`);
        lastStatus = status;
        lastPct    = -1;
      }
    }
    if (lastPct >= 0) process.stdout.write('\n');
    printSystem(`완료: ${chalk.cyan(name)}`);
  } catch (err) {
    process.stdout.write('\n');
    if (err.name === 'AbortError') { printSystem('다운로드 취소됨.'); }
    else                            { printError(err.message); }
  } finally {
    state._inModelPull = false;
    process.removeListener('SIGINT', onSigint);
  }
}

// ─── /memory ──────────────────────────────────────────────────────────────────

async function cmdMemory(args, state) {
  const sub = args[0];
  if (sub === 'clear') {
    await state.memory.clearMemory();
    printSystem('MEMORY.md 를 비웠습니다.');
    return;
  }
  if (sub === 'save') {
    const text = args.slice(1).join(' ');
    if (!text) { printSystem('사용법: /memory save <내용>'); return; }
    await state.memory.appendMemory(text);
    printSystem('MEMORY.md 에 저장됨.');
    return;
  }
  // default: show
  const content = await state.memory.loadFile(state.memory.memoryPath);
  if (!content) {
    printSystem('MEMORY.md 가 비어있습니다.');
  } else {
    console.log(`\n${chalk.bold('  MEMORY.md')}\n`);
    console.log(chalk.dim(content));
    console.log();
  }
}

// ─── /tools ───────────────────────────────────────────────────────────────────

// ─── /verify ──────────────────────────────────────────────────────────────────
// 답변 후 2차 검증 토글. 둘 다 기본 off(지연·opt-in).
//   self = 자기비판(verify.js), exec = 답변 코드를 샌드박스에서 실제 실행(execverify.js)
// 신뢰 우선순위: 실행 피드백 > 자기비판. exec 는 /sandbox on 과 함께 쓰는 것을 권장.
function cmdVerify(args, state) {
  const on = (v) => (v ?? 'off').toLowerCase() === 'on';
  const sub = (args[0] || 'status').toLowerCase();
  const val = (args[1] || '').toLowerCase();

  if (sub === 'on' || sub === 'off') { process.env.OH_VERIFY = sub; printSystem(`자기검증(self): ${sub === 'on' ? chalk.green('ON') : chalk.dim('OFF')}`); return; }
  if (sub === 'exec') {
    if (val === 'on' || val === 'off') { process.env.OH_EXEC_VERIFY = val; printSystem(`실행검증(exec): ${val === 'on' ? chalk.green('ON') : chalk.dim('OFF')}${val === 'on' && !sandboxEnabled() ? chalk.yellow('  — /sandbox on 권장(코드 실제 실행)') : ''}`); return; }
    printSystem('사용법: /verify exec on|off');
    return;
  }
  // status
  printSystem(`검증 — 자기검증(self): ${on(process.env.OH_VERIFY) ? chalk.green('ON') : chalk.dim('OFF')}  ·  실행검증(exec): ${on(process.env.OH_EXEC_VERIFY) ? chalk.green('ON') : chalk.dim('OFF')}  ${chalk.dim('(/verify on|off, /verify exec on|off)')}`);
}

// ─── /sandbox ─────────────────────────────────────────────────────────────────
// 실행 격리를 런타임에 토글(기본 host). 보안도구지만 PC 안 망가뜨림 원칙상 기본은
// 무격리 host, 위험한 실행이 필요할 때 사용자가 /sandbox on 으로 켠다.
function cmdSandbox(args, state) {
  const sub = (args[0] || 'status').toLowerCase();

  if (sub === 'on') {
    if (args[1]) process.env.OH_SANDBOX_DISTRO = args[1];
    process.env.OH_SANDBOX = 'wsl';
    const chk = checkSandbox();
    if (chk.ok) {
      printSystem(`🔒 실행 격리 ON — run_command/run_code 는 '${chk.distro}'(WSL) 안에서 실행됩니다. 윈도우 파일·실행 차단.`);
    } else {
      process.env.OH_SANDBOX = 'host';
      printError(`샌드박스 '${chk.distro}' 사용 불가: ${chk.error}`);
      printSystem('→ host(격리 off) 유지. 배포판 확인: wsl -l -v  ·  다른 배포판: /sandbox on <이름>');
    }
    return;
  }

  if (sub === 'off') {
    process.env.OH_SANDBOX = 'host';
    printSystem('실행 격리 OFF — 명령/코드는 호스트에서 직접 실행됩니다.');
    return;
  }

  // status (기본)
  if (sandboxEnabled()) {
    const chk = checkSandbox();
    printSystem(`실행 격리: ${chalk.green('ON')} (${sandboxLabel()})${chk.ok ? chalk.dim(' · 동작 확인됨') : chalk.red(' · 사용불가: ' + chk.error)}`);
  } else {
    printSystem(`실행 격리: ${chalk.dim('OFF (host 직접 실행)')}. 켜려면 ${chalk.cyan('/sandbox on')} [배포판]  ${chalk.dim(`(기본: ${sandboxDistro()})`)}`);
  }
}

function cmdTools(state) {
  const tools = state.allTools;
  const ICONS = {
    read_file:'📄', write_file:'✏️ ', edit_file:'✏️ ', delete_file:'🗑 ',
    move_file:'↔️ ', copy_file:'📋', create_directory:'📁', delete_directory:'🗑 ',
    list_directory:'📂', find_files:'🔍', search_files:'🔎',
    run_command:'▶ ', run_code:'⚡', web_search:'🌐', web_fetch:'🌐',
  };
  console.log(`\n${chalk.bold('  Tools')} ${chalk.dim(`(${tools.length} total)`)}\n`);
  for (const t of tools) {
    const fn   = t.function;
    const icon = ICONS[fn.name] ?? '⚙ ';
    console.log(`  ${icon} ${chalk.cyan(fn.name.padEnd(22))} ${chalk.dim(fn.description ?? '')}`);
  }
  console.log();
}

// ─── /plugins ─────────────────────────────────────────────────────────────────

function cmdPlugins(state) {
  const plugins = state.plugins?.list() ?? [];
  if (plugins.length === 0) {
    printSystem('No plugins loaded.\n\n  plugins/ 폴더에 .js 파일을 추가하세요. /help 에서 형식 확인.');
    return;
  }
  console.log(`\n${chalk.bold('  Plugins')}`);
  for (const p of plugins) {
    console.log(`    ${chalk.cyan(p.name)} — ${p.description} (${p.toolCount} tools)`);
  }
  console.log();
}

// ─── /mcp ─────────────────────────────────────────────────────────────────────

function cmdMcp(state) {
  const servers = state.mcpClients ?? [];
  if (servers.length === 0) {
    printSystem('No MCP servers connected.\n\n  oh.config.json 에 mcpServers 항목을 추가하세요. /help 에서 형식 확인.');
    return;
  }
  console.log(`\n${chalk.bold('  MCP Servers')}`);
  for (const s of servers) {
    console.log(`    ${chalk.cyan(s.name)} — ${s.tools.length} tools`);
  }
  console.log();
}

// ─── /cd ──────────────────────────────────────────────────────────────────────

async function cmdCd(args, state) {
  if (!args[0]) {
    printSystem(`현재 작업 디렉터리: ${chalk.white(process.cwd())}`);
    return;
  }
  const target = args.join(' ').trim(); // 경로에 공백 있을 수 있음
  const full   = resolve(process.cwd(), target);
  try {
    process.chdir(full);
    // 새 디렉터리에 맞게 메모리 경로 업데이트
    state.memory.workDir         = full;
    state.memory.agentsPath      = resolve(full, 'AGENTS.md');
    state.memory.rulesPath       = resolve(full, 'RULES.md');
    state.memory.memoryPath      = resolve(full, 'MEMORY.md');
    state.memory.conventionsPath = resolve(full, 'CONVENTIONS.md');
    printSystem(`작업 디렉터리 변경: ${chalk.white(full)}`);
  } catch (err) {
    printError(`디렉터리 변경 실패: ${err.message}`);
  }
}

// ─── /config ──────────────────────────────────────────────────────────────────

const CONFIG_DEFAULTS = { temperature: 0.8, top_p: 0.9, iterations: 3, effort: 'normal', search_results: 5 };

async function cmdConfig(args, state) {
  state.config = state.config ?? { ...CONFIG_DEFAULTS };

  if (!args[0] || args[0] === 'show') {
    console.log(`\n${chalk.bold('  Config')}\n`);
    console.log(`  ${chalk.dim('temperature'.padEnd(16))}${chalk.yellow(String(state.config.temperature ?? CONFIG_DEFAULTS.temperature))}  ${chalk.dim('(0~2, 응답 창의성)')}`);
    console.log(`  ${chalk.dim('top_p'.padEnd(16))}${chalk.yellow(String(state.config.top_p ?? CONFIG_DEFAULTS.top_p))}  ${chalk.dim('(0~1, 토큰 확률 범위)')}`);
    console.log(`  ${chalk.dim('iterations'.padEnd(16))}${chalk.yellow(String(state.config.iterations ?? CONFIG_DEFAULTS.iterations))}  ${chalk.dim('(툴 최대 반복 횟수)')}`);
    console.log(`  ${chalk.dim('search_results'.padEnd(16))}${chalk.yellow(String(state.config.search_results ?? CONFIG_DEFAULTS.search_results))}  ${chalk.dim('(검색 결과 수, /search 로 변경)')}`);
    console.log(`  ${chalk.dim('effort'.padEnd(16))}${chalk.cyan(state.config.effort ?? CONFIG_DEFAULTS.effort)}  ${chalk.dim('(/effort 로 변경)')}`);
    const vOn = (process.env.OH_VERIFY ?? 'on').toLowerCase() !== 'off';
    const vMode = (process.env.OH_VERIFY_MODE ?? 'flag').toLowerCase() === 'correct' ? 'correct' : 'flag';
    console.log(`  ${chalk.dim('self-verify'.padEnd(16))}${vOn ? chalk.green(vMode) : chalk.dim('off')}  ${chalk.dim('(자기검증 2차패스, env OH_VERIFY / OH_VERIFY_MODE)')}`);
    const sbOn = (process.env.OH_SANDBOX ?? 'host').toLowerCase() === 'wsl';
    console.log(`  ${chalk.dim('sandbox'.padEnd(16))}${sbOn ? chalk.green(sandboxLabel()) : chalk.dim('host (격리 off)')}  ${chalk.dim('(실행 격리 — /sandbox on 으로 토글)')}`);
    const exOn = (process.env.OH_EXEC_VERIFY ?? 'off').toLowerCase() === 'on';
    console.log(`  ${chalk.dim('exec-verify'.padEnd(16))}${exOn ? (sbOn ? chalk.green('on') : chalk.yellow('on (격리 필요)')) : chalk.dim('off')}  ${chalk.dim('(답변 코드 격리실행 검증, env OH_EXEC_VERIFY=on + OH_SANDBOX=wsl)')}`);
    const mqOn = (process.env.OH_MULTIQUERY ?? 'on').toLowerCase() !== 'off';
    const mqN = Math.max(0, parseInt(process.env.OH_MULTIQUERY_N ?? '2', 10) || 0);
    console.log(`  ${chalk.dim('multiquery'.padEnd(16))}${mqOn && mqN > 0 ? chalk.green(`on (+${mqN}각도)`) : chalk.dim('off')}  ${chalk.dim('(RAG 멀티쿼리 확장, env OH_MULTIQUERY / OH_MULTIQUERY_N)')}`);
    console.log();
    return;
  }

  if (args[0] === 'reset') {
    state.config = { ...CONFIG_DEFAULTS };
    printSystem('설정을 기본값으로 초기화했습니다.');
    await state.memory.updateModelSection(state.model, state.contextLength, state.config, state._github).catch(() => {});
    return;
  }

  const key = args[0];
  const val = args[1];

  if (!val) { printSystem(`Usage: /config ${key} <값>`); return; }

  const allowed = ['temperature', 'top_p', 'iterations', 'search_results'];
  if (!allowed.includes(key)) {
    printError(`알 수 없는 설정: ${key}\n  가능한 값: ${allowed.join(', ')}  (effort는 /effort 로 변경)`);
    return;
  }

  const num = parseFloat(val);
  if (isNaN(num)) { printError(`숫자 값이 필요합니다. (입력: ${val})`); return; }

  state.config[key] = (key === 'iterations' || key === 'search_results') ? Math.round(num) : num;
  printSystem(`${key} = ${chalk.yellow(String(state.config[key]))}  (다음 메시지부터 적용)`);
  await state.memory.updateModelSection(state.model, state.contextLength, state.config, state._github).catch(() => {});
}

// ─── /effort ──────────────────────────────────────────────────────────────────

const EFFORT_LEVELS = ['off', 'low', 'normal', 'high', 'max'];

const EFFORT_DESC = {
  off:    'thinking 완전 비활성  (think: false)',
  low:    'thinking 비활성      (think: false)',
  normal: '모델 기본값          (think 옵션 없음)',
  high:   'thinking 활성        (think: true)',
  max:    'thinking 활성 + 심층 추론 힌트 주입',
};

function cmdEffort(args, state) {
  state.config = state.config ?? {};

  const level = args[0]?.toLowerCase();

  if (!level) {
    const current = state.config.effort ?? 'normal';
    console.log(`\n${chalk.bold('  Effort')}\n`);
    for (const l of EFFORT_LEVELS) {
      const active = l === current ? chalk.green(' ←') : '';
      console.log(`  ${chalk.cyan(l.padEnd(8))} ${chalk.dim(EFFORT_DESC[l])}${active}`);
    }
    console.log(`\n  ${chalk.dim('/effort <레벨>  으로 변경')}\n`);
    return;
  }

  if (!EFFORT_LEVELS.includes(level)) {
    printSystem(`알 수 없는 레벨: ${level}\n  사용 가능: ${EFFORT_LEVELS.join(' | ')}`);
    return;
  }

  state.config.effort = level;
  printSystem(`Effort: ${chalk.cyan(level)}  — ${chalk.dim(EFFORT_DESC[level])}`);
  state.memory?.updateModelSection(state.model, state.contextLength, state.config, state._github).catch(() => {});
}

// ─── /search ─────────────────────────────────────────────────────────────────

function cmdSearch(args, state) {
  state.config = state.config ?? { ...CONFIG_DEFAULTS };

  const n = parseInt(args[0], 10);
  if (!args[0]) {
    const current = state.config.search_results ?? CONFIG_DEFAULTS.search_results;
    console.log(`\n  검색 결과 수: ${chalk.yellow(String(current))}개  ${chalk.dim('(1~20)')}`);
    console.log(`  ${chalk.dim('/search <숫자>  으로 변경')}\n`);
    return;
  }

  if (isNaN(n) || n < 1 || n > 20) {
    printError('1~20 사이의 숫자를 입력하세요.');
    return;
  }

  state.config.search_results = n;
  printSystem(`검색 결과 수: ${chalk.yellow(String(n))}개  (다음 검색부터 적용)`);
  state.memory?.updateModelSection(state.model, state.contextLength, state.config, state._github).catch(() => {});
}

// ─── /context ────────────────────────────────────────────────────────────────

const CONTEXT_SIZES = {
  '1': { label: '16K', value: 16384 },
  '2': { label: ' 8K', value: 8192  },
  '3': { label: '10K', value: 10240 },
};

async function cmdContext(args, state) {
  const sub = args[0];

  if (sub === 'reset') {
    state.contextLength = null;
    printSystem('컨텍스트 길이: 모델 기본값으로 초기화됨');
    await state.memory.updateModelSection(state.model, null, state.config, state._github).catch(() => {});
    return;
  }

  if (CONTEXT_SIZES[sub]) {
    const { label, value } = CONTEXT_SIZES[sub];
    state.contextLength = value;
    printSystem(`컨텍스트 길이 설정: ${label}  (${value.toLocaleString()} tokens)  — 다음 메시지부터 적용`);
    await state.memory.updateModelSection(state.model, value, state.config, state._github).catch(() => {});
    return;
  }

  const current = state.contextLength
    ? `${(state.contextLength / 1024).toFixed(0)}K  (${state.contextLength.toLocaleString()} tokens)`
    : '모델 기본값';

  console.log(`
${chalk.bold('  컨텍스트 길이')}  ${chalk.dim(`현재: ${current}`)}

  ${chalk.cyan('[1]')}  16K  ${chalk.dim('(16,384 tokens)')}
  ${chalk.cyan('[2]')}   8K  ${chalk.dim(' (8,192 tokens)')}
  ${chalk.cyan('[3]')}  10K  ${chalk.dim('(10,240 tokens)')}

  ${chalk.dim('/context <번호>  또는  /context reset')}
`);
}

// ─── /init ────────────────────────────────────────────────────────────────────

async function cmdInit(state) {
  printSystem('Scanning project…');

  let ctx;
  try {
    ctx = await gatherProjectContext(state.memory.workDir, state.contextLength);
  } catch (err) {
    printError(`Failed to scan project: ${err.message}`);
    return;
  }

  const fileCount = ctx.tree.length;
  const readCount = Object.keys(ctx.content).length;
  printSystem(`${fileCount}개 경로, ${readCount}개 파일 읽음.`);

  // ── Static sections (no LLM needed) ───────────────────────────────────────
  const staticMd = generateAgentsMd(ctx, state.memory.workDir);

  // ── LLM: Overview + Architecture + Conventions only ───────────────────────
  // Short focused prompt → less tokens → less chance of looping
  process.stdout.write(chalk.dim('  Analyzing project… '));

  const llmSections = await streamInitAnalysis(state.model, ctx, state.contextLength);

  process.stdout.write('done\n');

  // Merge: replace placeholder sections in staticMd with LLM output
  let agentsContent = staticMd;
  if (llmSections.overview) {
    agentsContent = agentsContent.replace(
      '<!-- /init이 자동 생성했습니다. 프로젝트 설명을 여기에 작성하세요. -->',
      llmSections.overview.trim(),
    );
  }
  if (llmSections.architecture) {
    agentsContent = agentsContent.replace(
      '<!-- 아키텍처 설명을 여기에 작성하세요. -->',
      llmSections.architecture.trim(),
    );
  }
  if (llmSections.conventions) {
    agentsContent = agentsContent.replace(
      '- 코드 스타일은 기존 파일을 따를 것\n- 불필요한 복잡성, 중복 코드 금지',
      llmSections.conventions.trim(),
    );
  }

  const existingAgents = (await state.memory.loadFile(state.memory.agentsPath)) ?? DEFAULT_CONVENTIONS;
  const PROJECT_MARKER = '<!-- ooh:project-knowledge -->';
  let finalAgents;
  if (existingAgents.includes(PROJECT_MARKER)) {
    finalAgents = existingAgents.replace(
      /<!-- ooh:project-knowledge -->[\s\S]*/,
      `${PROJECT_MARKER}\n${agentsContent.trim()}`,
    );
  } else {
    finalAgents = `${existingAgents.trimEnd()}\n\n---\n\n${PROJECT_MARKER}\n${agentsContent.trim()}`;
  }
  await state.memory.saveAgents(finalAgents);
  printSystem('AGENTS.md 생성 완료.');

  const memInit = buildMemoryInit(state.memory.workDir);
  await state.memory.saveMemory(memInit);
  printSystem('MEMORY.md 초기화 완료. /update 로 작업 기록 추가 가능.');
}

// ─── /check ───────────────────────────────────────────────────────────────────

async function cmdCheck(args, state) {
  const scope = args.join(' ') || 'full'; // 'full' or path hint

  printSystem('프로젝트 스캔 중…');
  let ctx;
  try {
    ctx = await gatherProjectContext(state.memory.workDir, state.contextLength);
  } catch (err) {
    printError(`스캔 실패: ${err.message}`);
    return;
  }

  const fileCount = Object.keys(ctx.content).length;
  printSystem(`${ctx.tree.length}개 경로, ${fileCount}개 파일 분석 중…`);

  const charBudget = ctxToCharLimit(state.contextLength);
  const PRIORITY   = ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  const ordered    = [
    ...PRIORITY.filter(k => ctx.content[k]),
    ...Object.keys(ctx.content).filter(k => !PRIORITY.includes(k)),
  ];

  const snippets = [];
  let used = 500;
  for (const k of ordered) {
    const block = `### ${k}\n\`\`\`\n${ctx.content[k]}\n\`\`\``;
    if (used + block.length > charBudget) break;
    snippets.push(block);
    used += block.length;
  }

  const prompt = `다음은 소프트웨어 프로젝트의 전체 소스 코드입니다.

${snippets.join('\n\n')}

위 코드를 분석하여 다음을 찾아주세요:
1. **버그** — 잘못된 로직, 널 참조, 경계값 오류, 예외 미처리 등
2. **플로우 오류** — 비정상 실행 경로, 데드락 가능성, 무한루프 위험
3. **연동 문제** — 모듈 간 인터페이스 불일치, 하드코딩된 값, 깨진 의존성

발견한 문제마다:
- 파일명과 위치
- 문제 내용
- 권장 수정 방향

문제가 없는 항목은 생략하고, 실제 문제만 보고하세요.`;

  printAssistantLabel();

  let raw = '';
  const seenHeaders = new Set();

  try {
    for await (const chunk of streamChat({
      model:    state.model,
      messages: [{ role: 'user', content: prompt }],
      tools:    [],
    })) {
      if (chunk.done) break;
      const text = chunk.message?.content;
      if (!text) continue;
      raw += text;
      printToken(text);

      // 반복 감지
      const headers = raw.match(/^#{1,3} .+/gm) ?? [];
      let repeated = false;
      for (const h of headers) {
        if (seenHeaders.has(h)) { repeated = true; break; }
        seenHeaders.add(h);
      }
      if (repeated) break;
    }
  } catch (err) {
    process.stdout.write('\n');
    if (err.name !== 'AbortError') printError(err.message);
    return;
  }

  process.stdout.write('\n');

  // 결과를 대화에 추가 (이후 "저 버그 고쳐줘" 같은 후속 질문 가능)
  state.messages.push({ role: 'user',      content: `/${scope === 'full' ? 'check' : 'check ' + scope} 결과를 분석해줘` });
  state.messages.push({ role: 'assistant', content: raw });
}

// ─── /init helper: LLM analysis (Overview + Architecture + Conventions) ──────
//
// Sends a short, focused prompt with NO system prompt so tool-calling
// instructions never reach the model. Streams the response and watches for
// repeated section headers — if the same ## heading appears twice, the model
// is looping and we stop early.

async function streamInitAnalysis(model, { tree, content, runtimes }, contextLength) {
  const charBudget = ctxToCharLimit(contextLength);

  const name = Object.keys(content).includes('package.json')
    ? (tryParseJson(content['package.json'])?.name ?? 'unknown')
    : tree[0]?.replace(/\/$/, '') ?? 'unknown';

  const fileList = tree.join('\n');

  // Fill snippets up to charBudget — priority files first, then source files
  const PRIORITY = ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  const ordered  = [
    ...PRIORITY.filter(k => content[k]),
    ...Object.keys(content).filter(k => !PRIORITY.includes(k)),
  ];

  const snippets = [];
  let used = fileList.length + 500; // rough prompt shell size
  for (const k of ordered) {
    const block = `### ${k}\n\`\`\`\n${content[k]}\n\`\`\``;
    if (used + block.length > charBudget) {
      // Try to fit a truncated version
      const room = charBudget - used - 30;
      if (room > 200) snippets.push(`### ${k}\n\`\`\`\n${content[k].slice(0, room)}\n… (truncated)\n\`\`\``);
      break;
    }
    snippets.push(block);
    used += block.length;
  }

  const skipped = ordered.length - snippets.length;
  if (skipped > 0) printSystem(`컨텍스트 한계로 ${skipped}개 파일 생략 (${(contextLength ?? 8192).toLocaleString()} 토큰 기준).`);

  const prompt = `You are analyzing a software project called "${name}".

Files:
\`\`\`
${fileList}
\`\`\`

${snippets.join('\n\n')}

Write ONLY these three sections in Korean. No other text, no tool calls, no explanations outside the sections.

## Overview
2-3 sentences: what this project does and its purpose.

## Architecture
How the code is structured: layers, data flow, key patterns.

## Conventions
Bullet list of naming/style/patterns found in the code.`;

  let raw = '';
  const seenHeaders = new Set();
  let stopped = false;

  try {
    for await (const chunk of streamChat({ model, messages: [{ role: 'user', content: prompt }], tools: [] })) {
      if (chunk.done) break;
      const text = chunk.message?.content;
      if (!text) continue;
      raw += text;

      // Repetition guard: if a ## header appears a second time, stop
      const headers = raw.match(/^## \S[^\n]*/gm) ?? [];
      for (const h of headers) {
        if (seenHeaders.has(h)) { stopped = true; break; }
        seenHeaders.add(h);
      }
      if (stopped) break;
    }
  } catch { /* non-fatal — return what we have */ }

  // Parse out the three sections
  const extract = (label) => {
    const m = raw.match(new RegExp(`## ${label}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1].trim() : '';
  };

  const result = {
    overview:     extract('Overview'),
    architecture: extract('Architecture'),
    conventions:  extract('Conventions'),
  };

  // Retry any section that was cut off or empty
  const SECTION_PROMPTS = {
    overview:     `이 프로젝트가 무엇을 하는지 한국어로 2-3문장으로만 설명하세요. 다른 텍스트 없이 설명문만 출력하세요.\n\n파일 목록:\n${fileList}${snippets[0] ? `\n\n${snippets[0]}` : ''}`,
    architecture: `이 프로젝트의 코드 구조(레이어, 데이터 흐름, 주요 패턴)를 한국어로 3-5줄로만 설명하세요. 다른 텍스트 없이 설명문만 출력하세요.\n\n파일 목록:\n${fileList}`,
    conventions:  `이 프로젝트의 코딩 컨벤션(네이밍, 스타일, 패턴)을 한국어 불릿 리스트로만 출력하세요. 다른 텍스트 없이 리스트만 출력하세요.\n\n${snippets.slice(0, 2).join('\n\n')}`,
  };

  for (const [key, fallbackPrompt] of Object.entries(SECTION_PROMPTS)) {
    if (result[key]) continue; // already have content
    process.stdout.write(chalk.dim(`  Retrying ${key}… `));
    let retried = '';
    try {
      for await (const chunk of streamChat({ model, messages: [{ role: 'user', content: fallbackPrompt }], tools: [] })) {
        if (chunk.done) break;
        const text = chunk.message?.content;
        if (!text) continue;
        retried += text;
        // Same guard on retry
        const headers = retried.match(/^## \S/gm) ?? [];
        if (headers.length > 1) break;
      }
      result[key] = retried.trim();
      process.stdout.write('done\n');
    } catch {
      process.stdout.write('skip\n');
    }
  }

  return result;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── /update ──────────────────────────────────────────────────────────────────

async function cmdUpdate(args, state) {
  const target   = args[0] ?? 'all';
  const doMemory = target === 'all' || target === 'memory';
  const doAgents = target === 'all' || target === 'agents';

  const convText = formatConversation(state.messages);
  const meaningfulTurns = state.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') &&
            m.content?.trim() &&
            !m.content.startsWith('[Compressed context]'),
  ).length;
  if (meaningfulTurns < 2) {
    printSystem('대화 내용이 없습니다. 먼저 대화를 나눠주세요.');
    return;
  }

  if (doMemory) {
    console.log(chalk.bold('\n  Updating MEMORY.md…'));
    printAssistantLabel();

    let entry = '';
    try {
      for await (const chunk of streamChat({
        model:    state.model,
        messages: [{ role: 'user', content: buildWorkLogPrompt(convText) }],
        tools:    [],
      })) {
        if (chunk.message?.content) { printToken(chunk.message.content); entry += chunk.message.content; }
      }
    } catch (err) {
      process.stdout.write('\n');
      printError(`MEMORY.md update failed: ${err.message}`);
    }
    process.stdout.write('\n');

    if (entry.trim()) {
      const date    = new Date().toISOString().split('T')[0];
      await state.memory.appendMemory(`## ${date}\n\n${entry.trim()}`);
      printSystem('MEMORY.md updated with today\'s work log.');
    }
  }

  if (doAgents) {
    const currentAgents = await state.memory.loadFile(state.memory.agentsPath);
    if (!currentAgents) {
      printSystem('AGENTS.md not found — run /init first.');
    } else {
      console.log(chalk.bold('\n  Updating AGENTS.md…'));
      printAssistantLabel();

      const workHint = doMemory ? '(see work log above)' : convText.slice(0, 3000);
      let updated = '';
      try {
        for await (const chunk of streamChat({
          model:    state.model,
          messages: [{ role: 'user', content: buildAgentsUpdatePrompt(currentAgents, workHint) }],
          tools:    [],
        })) {
          if (chunk.message?.content) { printToken(chunk.message.content); updated += chunk.message.content; }
        }
      } catch (err) {
        process.stdout.write('\n');
        printError(`AGENTS.md update failed: ${err.message}`);
      }
      process.stdout.write('\n');

      if (updated.trim()) {
        await state.memory.saveAgents(updated.trim());
        printSystem('AGENTS.md updated with new project knowledge.');
      }
    }
  }
}

// ─── /session ─────────────────────────────────────────────────────────────────

async function cmdSession(args, state) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const sessions = await state.sessions.list();
    if (sessions.length === 0) { printSystem('No saved sessions.'); return; }
    console.log(`\n${chalk.bold('  Sessions')} ${chalk.dim(`(${sessions.length})`)}`);
    for (const s of sessions) {
      const isCurrent = s.id === state.sessions.currentId;
      const marker = isCurrent ? chalk.green(' ← current') : '';
      const date   = s.updatedAt ? chalk.dim(` ${s.updatedAt.slice(0, 16).replace('T', ' ')}`) : '';
      // Show first user message as preview if name is just the date ID
      const isDefaultName = /^\d{4}-\d{2}-\d{2}T/.test(s.name);
      const preview = isDefaultName && s.firstMessage
        ? chalk.dim(`  "${s.firstMessage.slice(0, 40)}${s.firstMessage.length > 40 ? '…' : ''}"`)
        : '';
      console.log(`    ${chalk.cyan(s.id.slice(0, 16))} ${chalk.dim(`[${s.model}]`)} ${chalk.dim(`${s.messageCount}msgs`)}${date}${marker}${preview}`);
    }
    console.log();
    return;
  }

  if (sub === 'save') {
    const name = args.slice(1).join(' ') || null;
    const id   = await state.sessions.save(state, name);
    printSystem(`Session saved: ${chalk.cyan(name ?? id)}`);
    return;
  }

  if (sub === 'last') {
    const sessions = await state.sessions.list();
    if (sessions.length === 0) { printSystem('No saved sessions.'); return; }
    const saved = await state.sessions.load(sessions[0].id);
    if (saved) {
      Object.assign(state, {
        messages: saved.messages ?? [],
        compressedHistory: saved.compressedHistory ?? null,
        model: saved.model ?? state.model,
        toolMode: saved.toolMode ?? 'auto',
      });
      printSystem(`Resumed last session: ${chalk.cyan(saved.name)}  (${state.messages.length} messages)`);
    }
    return;
  }

  if (sub === 'load') {
    const target = args[1];
    if (!target) { printSystem('Usage: /session load <id-or-name>'); return; }
    const saved = await state.sessions.load(target);
    if (!saved) { printSystem(`Session not found: ${target}`); return; }
    Object.assign(state, {
      messages: saved.messages ?? [],
      compressedHistory: saved.compressedHistory ?? null,
      model: saved.model ?? state.model,
      toolMode: saved.toolMode ?? 'auto',
    });
    printSystem(`Loaded session: ${chalk.cyan(saved.name)}  (${state.messages.length} messages, model: ${state.model})`);
    return;
  }

  if (sub === 'delete') {
    const target = args[1];
    if (!target) { printSystem('Usage: /session delete <id-or-name>'); return; }
    const ok = await state.sessions.delete(target);
    printSystem(ok ? `Deleted session: ${target}` : `Session not found: ${target}`);
    return;
  }

  if (sub === 'new') {
    Object.assign(state, { messages: [], compressedHistory: null, toolMode: 'auto' });
    state.sessions.currentId = null;
    printSystem('Started a new session.');
    return;
  }

  printSystem(`Unknown sub-command: /session ${sub}  — try /help`);
}

// ─── /paste ───────────────────────────────────────────────────────────────────

async function cmdPaste(state) {
  if (process.platform !== 'win32') {
    printSystem('/paste is only supported on Windows.');
    return;
  }

  printSystem('Reading image from clipboard…');

  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { Write-Error "no image in clipboard"; exit 1 }',
    '$ms = New-Object System.IO.MemoryStream',
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join('; ');

  try {
    const { stdout } = await execP(`powershell -NoProfile -Command "${ps}"`, { maxBuffer: 20 * 1024 * 1024 });
    const base64 = stdout.trim();
    if (!base64) throw new Error('empty result');
    state._pendingImages = state._pendingImages ?? [];
    state._pendingImages.push(base64);
    printSystem(`Clipboard image ready (${Math.round(base64.length * 0.75 / 1024)} KB). Send your next message to attach it.`);
  } catch (err) {
    printError(`No image in clipboard or failed to read. (${err.stderr?.trim() || err.message})`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatConversation(messages) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .filter((m) => !m.content.startsWith('[Compressed context]'))
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 600)}`)
    .join('\n\n');
}

// ─── /git ─────────────────────────────────────────────────────────────────────

async function cmdGit(args, state) {
  const cwd = process.cwd();

  if (!(await isGitRepo(cwd))) {
    printSystem('Git 저장소가 아닙니다. (git init 으로 초기화하세요)');
    return;
  }

  const sub = args[0]?.toLowerCase();

  // /git  or  /git status
  if (!sub || sub === 'status') {
    const r = await gitStatus(cwd);
    console.log(`\n${chalk.bold('  Git Status')}\n`);
    console.log(chalk.dim(r.out.split('\n').map(l => `  ${l}`).join('\n')));
    console.log();
    return;
  }

  // /git commit [all]
  if (sub === 'commit') {
    const addAll = args[1] === 'all';
    if (addAll) await gitAdd(cwd, ['.']);

    const diff = await getGitDiff(cwd, { staged: true }) ?? await getGitDiff(cwd);
    if (!diff) {
      printSystem('커밋할 변경사항이 없습니다.');
      return;
    }

    printSystem('AI가 커밋 메시지를 생성 중…');
    printAssistantLabel();

    let message = '';
    try {
      for await (const chunk of streamChat({
        model:    state.model,
        messages: [{
          role:    'user',
          content: `다음 git diff를 보고 간결한 커밋 메시지를 작성해줘.\n` +
                   `형식: <type>(<scope>): <subject>\n` +
                   `type은 feat/fix/refactor/docs/style/test/chore 중 하나.\n` +
                   `메시지만 출력하고 설명은 생략.\n\n` +
                   `\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``,
        }],
        tools: [],
      })) {
        if (chunk.message?.content) {
          printToken(chunk.message.content);
          message += chunk.message.content;
        }
      }
    } catch (err) {
      process.stdout.write('\n');
      printError(`생성 실패: ${err.message}`);
      return;
    }
    process.stdout.write('\n');

    message = message.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '');

    // Confirm
    const answer = await new Promise(res =>
      state._rl.question(
        `\n  ${chalk.dim('커밋 메시지')}  ${chalk.white(message)}\n` +
        `  ${chalk.dim('Enter = 확인, 직접입력 = 수정, q = 취소: ')}`,
        res,
      ),
    );

    if (answer.trim().toLowerCase() === 'q') {
      printSystem('커밋 취소.');
      return;
    }
    const finalMsg = answer.trim() || message;

    if (!addAll) await gitAdd(cwd, ['.']);
    const result = await gitCommit(cwd, finalMsg);
    printCommandOutput('git commit', {
      success: result.ok,
      exit_code: result.ok ? 0 : 1,
      stdout: result.ok ? result.message : '',
      stderr: result.ok ? '' : result.message,
    });
    return;
  }

  // /git branch [name] [-b newname]
  if (sub === 'branch') {
    if (!args[1]) {
      const r = await gitListBranches(cwd);
      console.log(`\n${chalk.bold('  Branches')}\n`);
      console.log(chalk.dim(r.out.split('\n').map(l => `  ${l}`).join('\n')));
      console.log();
      return;
    }
    if (args[1] === '-b' && args[2]) {
      const r = await gitCheckout(cwd, args[2], true);
      printCommandOutput('git checkout -b', {
        success: r.ok, exit_code: r.ok ? 0 : 1,
        stdout: r.ok ? r.message : '', stderr: r.ok ? '' : r.message,
      });
      return;
    }
    const r = await gitCheckout(cwd, args[1]);
    printCommandOutput('git checkout', {
      success: r.ok, exit_code: r.ok ? 0 : 1,
      stdout: r.ok ? r.message : '', stderr: r.ok ? '' : r.message,
    });
    return;
  }

  // /git push
  if (sub === 'push') {
    const r = await gitPush(cwd);
    printCommandOutput('git push', {
      success: r.ok, exit_code: r.ok ? 0 : 1,
      stdout: r.ok ? r.message : '', stderr: r.ok ? '' : r.message,
    });
    return;
  }

  // /git issues
  if (sub === 'issues') {
    const gh = state._github;
    if (!gh?.owner || !gh?.repo) {
      printSystem('환경변수 GITHUB_OWNER, GITHUB_REPO 를 설정해주세요.\n  예: GITHUB_OWNER=myuser GITHUB_REPO=myrepo ooh');
      return;
    }
    printSystem('GitHub 이슈 가져오는 중…');
    const issues = await githubListIssues(gh.owner, gh.repo, gh.token, { limit: 15 });
    if (!issues) { printError('이슈를 가져오지 못했습니다. token / 저장소 설정을 확인하세요.'); return; }
    console.log(`\n${chalk.bold(`  Issues — ${gh.owner}/${gh.repo}`)} ${chalk.dim(`(${issues.length})`)}\n`);
    for (const i of issues) {
      const labels = i.labels.length ? chalk.dim(` [${i.labels.join(', ')}]`) : '';
      console.log(`  ${chalk.cyan(`#${String(i.number).padEnd(5)}`)} ${i.title}${labels}`);
    }
    console.log();
    return;
  }

  printSystem(`알 수 없는 하위 명령: /git ${sub}  (/help 참고)`);
}

// ─── /diff ────────────────────────────────────────────────────────────────────

async function cmdDiff(args, state) {
  const cwd = process.cwd();
  if (!(await isGitRepo(cwd))) {
    printSystem('Git 저장소가 아닙니다.');
    return;
  }

  const file = args[0] ?? null;
  const diff = await getGitDiff(cwd, { file });
  if (!diff) {
    printSystem('변경사항 없음.');
    return;
  }

  // Show raw diff with git coloring
  printCommandOutput(`git diff${file ? ` ${file}` : ''}`, {
    success: true, exit_code: 0, stdout: diff, stderr: '',
  });

  // AI review
  printSystem('AI가 diff를 리뷰 중…');
  printAssistantLabel();
  try {
    for await (const chunk of streamChat({
      model:    state.model,
      messages: [{
        role:    'user',
        content: `이 git diff를 리뷰해줘. 잠재적인 버그, 개선점, 놓친 부분을 간결하게 지적해줘.\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
      }],
      tools: [],
    })) {
      if (chunk.message?.content) printToken(chunk.message.content);
    }
  } catch (err) {
    printError(`리뷰 실패: ${err.message}`);
  }
  process.stdout.write('\n');
}

// ─── /todo ────────────────────────────────────────────────────────────────────

async function cmdTodo(args, state) {
  const cwd    = process.cwd();
  const tags   = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE'];
  const pattern = tags.join('|');

  const TEXT_EXTS = new Set(['.js','.ts','.jsx','.tsx','.py','.go','.rs','.java',
    '.c','.cpp','.h','.cs','.rb','.php','.swift','.kt','.vue','.svelte','.md','.txt']);
  const SKIP = new Set(['node_modules','.git','dist','build','.cache','__pycache__','coverage']);

  const results = [];
  const re = new RegExp(`(${pattern})\\s*[:/]?\\s*(.*)`, 'i');

  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(abs);
      } else if (TEXT_EXTS.has(extname(e.name).toLowerCase())) {
        try {
          const s = await stat(abs);
          if (s.size > 200_000) continue;
          const text  = await readFile(abs, 'utf-8');
          const lines = text.split('\n');
          const rel   = relative(cwd, abs).replace(/\\/g, '/');
          lines.forEach((line, i) => {
            const m = re.exec(line);
            if (m) results.push({ file: rel, line: i + 1, tag: m[1].toUpperCase(), text: m[2].trim().slice(0, 120) });
          });
        } catch { /* skip */ }
      }
    }
  }

  await walk(cwd);

  if (results.length === 0) { printSystem('TODO / FIXME 없음.'); return; }

  const byTag = {};
  for (const r of results) {
    (byTag[r.tag] = byTag[r.tag] ?? []).push(r);
  }

  console.log(`\n${chalk.bold('  TODO / FIXME')} ${chalk.dim(`(${results.length} total)`)}\n`);
  for (const [tag, items] of Object.entries(byTag)) {
    const color = tag === 'FIXME' ? chalk.red : tag === 'HACK' ? chalk.yellow : chalk.cyan;
    console.log(`  ${color(tag)} ${chalk.dim(`(${items.length})`)}`);
    for (const item of items) {
      console.log(`    ${chalk.dim(`${item.file}:${item.line}`)}  ${item.text || chalk.dim('(no text)')}`);
    }
    console.log();
  }
}

// ─── /lint ────────────────────────────────────────────────────────────────────

async function cmdLint(args, state) {
  const cwd = process.cwd();

  // Detect what's available from package.json
  let pkgJson = null;
  try { pkgJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')); } catch { /* */ }

  const hasDep = (name) =>
    pkgJson?.dependencies?.[name] || pkgJson?.devDependencies?.[name];

  const tasks = [];
  if (hasDep('eslint') || existsSync(join(cwd, '.eslintrc.json')) || existsSync(join(cwd, 'eslint.config.js')) || existsSync(join(cwd, 'eslint.config.mjs'))) {
    tasks.push({ label: 'ESLint', cmd: 'npx eslint . --max-warnings 0' });
  }
  if (hasDep('prettier')) {
    tasks.push({ label: 'Prettier', cmd: 'npx prettier --check .' });
  }
  if (hasDep('typescript') || existsSync(join(cwd, 'tsconfig.json'))) {
    tasks.push({ label: 'TypeScript', cmd: 'npx tsc --noEmit' });
  }
  // Custom lint script in package.json
  if (pkgJson?.scripts?.lint && !tasks.length) {
    tasks.push({ label: 'npm lint', cmd: 'npm run lint' });
  }

  if (tasks.length === 0) {
    printSystem('ESLint / Prettier / TypeScript 설정 파일을 찾지 못했습니다.\n  직접 실행: ooh 에서 말로 요청하거나 run_command 툴 사용');
    return;
  }

  for (const task of tasks) {
    printSystem(`Running ${task.label}…`);
    try {
      const { stdout, stderr } = await execP(task.cmd, { cwd, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      printCommandOutput(task.cmd, { success: true, exit_code: 0, stdout, stderr });
    } catch (err) {
      printCommandOutput(task.cmd, {
        success: false,
        exit_code: err.code ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      });
    }
  }
}

// ─── /undo ────────────────────────────────────────────────────────────────────

async function cmdUndo(args, state) {
  if (!state.backup) { printSystem('백업 시스템이 초기화되지 않았습니다.'); return; }

  if (args[0] === 'list') {
    const list = state.backup.list();
    if (list.length === 0) { printSystem('되돌릴 항목 없음.'); return; }
    console.log(`\n${chalk.bold('  Undo stack')} ${chalk.dim(`(${list.length})`)} ${chalk.dim('— 최신 순')}\n`);
    for (const item of list) {
      console.log(`  ${chalk.cyan(item.time.padEnd(12))} ${item.path}`);
    }
    console.log();
    return;
  }

  const result = await state.backup.undo();
  if (result.ok) {
    console.log(chalk.green(`\n  ✓ ${result.message}\n`));
  } else {
    console.log(chalk.red(`\n  ✗ ${result.message}\n`));
  }
}

// ─── /watch ──────────────────────────────────────────────────────────────────

async function cmdWatch(args, state) {
  const sub = args[0]?.toLowerCase();

  if (sub === 'stop') {
    if (state._watcher) {
      state._watcher.close();
      state._watcher    = null;
      state._watchQueue = [];
      printSystem('파일 감시 중지됨.');
    } else {
      printSystem('파일 감시가 실행 중이지 않습니다.');
    }
    return;
  }

  if (state._watcher) {
    printSystem('이미 파일 감시 중입니다. (/watch stop 으로 중지)');
    return;
  }

  const cwd = process.cwd();
  state._watchQueue = [];

  const SKIP_RE = /node_modules|\.git|dist[/\\]|build[/\\]/;

  try {
    const { watch: fsWatch } = await import('fs');
    state._watcher = fsWatch(cwd, { recursive: true }, (eventType, filename) => {
      if (!filename || SKIP_RE.test(filename)) return;
      const q = state._watchQueue;
      // Deduplicate: remove previous entry for same file
      const idx = q.findIndex(e => e.path === filename);
      if (idx !== -1) q.splice(idx, 1);
      q.push({ type: eventType, path: filename, ts: Date.now() });
    });

    state._watcher.on('error', () => {
      state._watcher = null;
      state._watchQueue = [];
    });

    printSystem(`파일 감시 시작 — ${chalk.white(cwd)}\n  변경 시 다음 메시지 전에 알림이 표시됩니다. (/watch stop 으로 중지)`);
  } catch (err) {
    printError(`파일 감시 시작 실패: ${err.message}`);
  }
}

// ─── /rag ───────────────────────────────────────────────────────────────────────
// 로컬 보안 지식베이스 관리: add | list | remove | clear | reindex | search

async function cmdRag(input, state) {
  const rest = input.trim().replace(/^\/rag\s*/i, '');
  const sub  = (rest.split(/\s+/)[0] || '').toLowerCase();
  const arg  = rest.slice(sub.length).trim();   // 공백 포함 경로 보존

  const rag = await import('../src/rag.js').catch(() => import('./rag.js'));

  try {
    switch (sub) {
      case 'add': {
        if (!arg) { printError('사용법: /rag add <파일경로 | URL>'); return; }
        let text, title, source;
        if (/^https?:\/\//i.test(arg)) {
          const { executeTool } = await import('./tools.js');
          const res = await executeTool('web_fetch', { url: arg, max_chars: 100_000 });
          if (res.error || !res.content) { printError(`URL 가져오기 실패: ${res.error || '빈 내용'}`); return; }
          text = res.content; source = arg; title = res.title || arg;
        } else {
          const full = resolve(process.cwd(), arg);
          if (!existsSync(full)) { printError(`파일 없음: ${full}`); return; }
          text = await readFile(full, 'utf-8');
          source = full; title = arg.split(/[\\/]/).pop();
        }
        printSystem(`적재 중: ${chalk.white(title)} …`);
        const r = await rag.addDocument({ source, title, text });
        printSystem(`✓ 적재 완료 — ${chalk.green(r.chunks)}개 청크 (${source})`);
        break;
      }
      case 'add-repo': {
        // /rag add-repo <owner/repo> [pathPrefix] [--readme] [--tier N] [--max N]
        const toks = arg.split(/\s+/).filter(Boolean);
        if (!toks[0]?.includes('/')) { printError('사용법: /rag add-repo <owner/repo> [경로] [--readme] [--tier 2] [--max 80]'); return; }
        const [owner, name] = toks[0].split('/');
        let pathPrefix = '', tier = 2, max = 80, onlyReadme = false;
        for (let i = 1; i < toks.length; i++) {
          const t = toks[i];
          if (t === '--readme') onlyReadme = true;
          else if (t === '--tier') tier = Number(toks[++i]);
          else if (t === '--max') max = Number(toks[++i]);
          else pathPrefix = t;
        }
        const { loadGithubMarkdown } = await import('../src/connectors.js').catch(() => import('./connectors.js'));
        printSystem(`${toks[0]} 트리 조회 중…`);
        const { branch, files } = await loadGithubMarkdown(owner, name, { pathPrefix, onlyReadme, max });
        if (files.length === 0) { printError('적재할 .md 파일이 없습니다.'); return; }
        printSystem(`${files.length}개 .md 적재 시작 (branch ${branch}, tier ${tier})…`);
        let ok = 0, chunks = 0;
        for (const f of files) {
          try {
            const r = await fetch(f.rawUrl, { signal: AbortSignal.timeout(20_000) });
            if (!r.ok) { printError(`  skip ${f.path} (${r.status})`); continue; }
            const text = await r.text();
            if (!text.trim()) continue;
            const res = await rag.addDocument({ source: `${owner}/${name}:${f.path}`, title: f.path, text, tier });
            ok++; chunks += res.chunks;
            if (ok % 10 === 0) process.stdout.write(`  …${ok}/${files.length}\n`);
          } catch (e) { printError(`  skip ${f.path} (${e.message})`); }
        }
        printSystem(`✓ 적재 완료 — 문서 ${ok}개, 청크 ${chunks}개 (${toks[0]})`);
        break;
      }
      case 'list': case 'ls': {
        const docs = rag.listDocuments();
        if (docs.length === 0) { printSystem('지식베이스가 비어 있습니다. /rag add <파일|URL>'); return; }
        printSystem(`지식베이스 문서 ${docs.length}개:`);
        for (const d of docs) {
          printInfo(`  #${d.id}  ${chalk.white(d.title || d.source)}  (${d.chunks}청크)  ${chalk.dim(d.source)}`);
        }
        break;
      }
      case 'remove': case 'rm': {
        if (!arg) { printError('사용법: /rag remove <문서ID | source>'); return; }
        const ok = await rag.removeDocument(arg);
        printSystem(ok ? `✓ 삭제됨: ${arg}` : `해당 문서 없음: ${arg}`);
        break;
      }
      case 'clear': {
        await rag.clearAll();
        printSystem('✓ 지식베이스 전체 삭제됨.');
        break;
      }
      case 'reindex': {
        printSystem('재색인 중(현재 임베딩 모델로 다시 임베딩)…');
        const r = await rag.reindexAll();
        printSystem(`✓ 재색인 완료 — ${r.reindexed}개 청크`);
        break;
      }
      case 'search': case 'find': {
        if (!arg) { printError('사용법: /rag search <질의>'); return; }
        const hits = await rag.searchHybrid(arg, { topK: 5 });
        if (hits.length === 0) { printSystem('지식베이스에 관련 내용 없음.'); return; }
        printSystem(`검색 결과 (${hits.length}):`);
        for (const h of hits) {
          const cite = h.heading ? `${h.source} › ${h.heading}` : h.source;
          printInfo(`  ${chalk.green(h.score.toFixed(3))}  ${chalk.dim(cite)}\n      ${h.body.slice(0, 80).replace(/\n/g, ' ')}…`);
        }
        break;
      }
      default: {
        const s = rag.stats();
        printSystem(
          `지식베이스 상태\n` +
          `  문서: ${s.docs}개 | 청크: ${s.chunks}개 | 임베딩: ${s.model}\n` +
          `  DB: ${chalk.dim(s.dbPath)}\n\n` +
          `  /rag add <파일|URL>   문서 적재\n` +
          `  /rag add-repo <o/r>   GitHub 저장소 .md 일괄적재\n` +
          `  /rag list             문서 목록\n` +
          `  /rag search <질의>    검색 테스트\n` +
          `  /rag remove <ID>      문서 삭제\n` +
          `  /rag reindex          재색인\n` +
          `  /rag clear            전체 삭제`
        );
      }
    }
  } catch (err) {
    printError(`RAG 오류: ${err.message}`);
  }
}

