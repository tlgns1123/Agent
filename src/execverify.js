/**
 * OH — 실행검증 (Phase 3 잔여 × Phase 4 격리)
 *
 * 모델 답변에 들어있는 "실행 가능한 코드/명령 블록"을 격리 샌드박스에서 실제로 실행해
 * 성공/실패(종료코드·출력)로 답을 검증한다. 말로만 하는 자기검증(verify.js)을 보완한다.
 *
 * 안전 원칙: 호스트(윈도우)에서는 절대 실행하지 않는다. OH_SANDBOX=wsl 로 격리가
 * 켜져 있을 때만 동작하며, 명백히 파괴적인 명령은 격리 안이라도 실행하지 않는다.
 *
 * env:
 *   OH_EXEC_VERIFY   on/off   (기본 off — 코드를 실제 실행하므로 명시적 opt-in)
 *   OH_EXEC_MAX      실행할 최대 블록 수            (기본 3)
 *   OH_EXEC_TIMEOUT  블록당 타임아웃 ms             (기본 20000)
 */

import chalk from 'chalk';
import { sandboxEnabled, sandboxLabel } from './sandbox.js';
import { executeTool } from './tools.js';

export function execVerifyEnabled() {
  return (process.env.OH_EXEC_VERIFY ?? 'off').toLowerCase() === 'on';
}
function execMax() {
  const n = parseInt(process.env.OH_EXEC_MAX ?? '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function execTimeout() {
  const n = parseInt(process.env.OH_EXEC_TIMEOUT ?? '20000', 10);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

// 펜스 언어 → run_code 언어. 실행 가능한 언어만 매핑(그 외는 검증 대상 아님).
const LANG_MAP = {
  bash: 'shell', sh: 'shell', shell: 'shell', console: 'shell', zsh: 'shell',
  python: 'python', py: 'python', python3: 'python',
  node: 'node', javascript: 'node', js: 'node',
};

// 명백히 파괴적/위험한 명령은 격리 안이라도 실행하지 않는다(실수·노이즈 방지).
const DANGEROUS = /(\brm\s+-rf?\s+\/(?:\s|$|\*)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bshutdown\b|\breboot\b|\bhalt\b|\b(?:poweroff|init\s+0)\b|>\s*\/dev\/sd)/i;

/**
 * 답변에서 펜스 코드블록 중 "실행 가능한 언어"만 추출한다.
 * 반환: { lang:'shell'|'python'|'node', code }[]
 */
export function extractRunnables(answer) {
  const text = (answer ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const re = /```([A-Za-z0-9+_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = LANG_MAP[(m[1] || '').toLowerCase()];
    const raw = m[2].replace(/\s+$/, '');
    if (!lang || !raw.trim()) continue;
    // 셸 블록: 줄머리 프롬프트 기호($, #)와 그 공백 제거
    const code = lang === 'shell'
      ? raw.split('\n').map(l => l.replace(/^\s*[$#]\s+/, '')).join('\n')
      : raw;
    out.push({ lang, code });
  }
  return out;
}

/**
 * 실행검증 실행. 비활성/추출 없음이면 null. 격리 꺼져 있으면 {verdict:'skip'}.
 * 반환: { verdict:'ran'|'skip', sandbox?, results?, reason? }
 */
export async function runExecVerification(state, { answer } = {}) {
  if (!execVerifyEnabled()) return null;

  const blocks = extractRunnables(answer).slice(0, execMax());
  if (blocks.length === 0) return null;                       // 실행할 게 없으면 조용히 패스

  if (!sandboxEnabled()) return { verdict: 'skip', reason: 'sandbox-off' };  // 격리 없으면 실행 안 함

  const results = [];
  for (const b of blocks) {
    if (DANGEROUS.test(b.code)) { results.push({ ...b, skipped: 'dangerous' }); continue; }
    try {
      const r = b.lang === 'shell'
        ? await executeTool('run_command', { command: b.code, timeout: execTimeout() })
        : await executeTool('run_code', { language: b.lang, code: b.code });
      results.push({
        lang: b.lang,
        code: b.code,
        success: r.success === true,
        exit_code: r.exit_code,
        stdout: (r.stdout ?? '').slice(0, 1500),
        stderr: (r.stderr ?? '').slice(0, 1000),
      });
    } catch (e) {
      results.push({ lang: b.lang, code: b.code, success: false, error: e.message });
    }
  }
  return { verdict: 'ran', sandbox: sandboxLabel(), results };
}

/** 실행검증 결과를 콘솔에 출력. */
export function presentExecVerification(result) {
  if (!result) return;

  if (result.verdict === 'skip') {
    console.log(chalk.dim(`\n  ⊘ 실행검증 건너뜀 (격리 샌드박스 off — OH_SANDBOX=wsl 로 켜면 실제 실행 검증)`));
    return;
  }

  const ran = result.results.filter(r => !r.skipped);
  const ok  = ran.filter(r => r.success).length;
  const head = ok === ran.length
    ? chalk.green(`\n  ▶ 실행검증 (${result.sandbox}): ${ok}/${ran.length} 블록 성공`)
    : chalk.yellow(`\n  ▶ 실행검증 (${result.sandbox}): ${ok}/${ran.length} 블록 성공 (실패 ${ran.length - ok})`);
  console.log(head);

  result.results.forEach((r, i) => {
    if (r.skipped) { console.log(chalk.dim(`    ${i + 1}. [${r.lang}] 건너뜀 (위험 명령 차단)`)); return; }
    const tag = r.success
      ? chalk.green(`✓ 성공 (exit ${r.exit_code})`)
      : chalk.red(`✗ 실패 (exit ${r.exit_code ?? '?'})`);
    console.log(`    ${i + 1}. [${r.lang}] ${tag}`);
    const out = (r.stdout || '').trim();
    const err = (r.stderr || r.error || '').trim();
    if (out) console.log(chalk.dim('       stdout: ' + out.split('\n').slice(0, 3).join(' / ').slice(0, 160)));
    if (!r.success && err) console.log(chalk.dim('       stderr: ' + err.split('\n').slice(0, 3).join(' / ').slice(0, 160)));
  });
}
