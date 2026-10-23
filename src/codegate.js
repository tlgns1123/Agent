/**
 * OH — 정적 코드 게이트 (객관 품질 검증, 실행 없음)
 *
 * 모델 답변의 코드블록을 "실행하지 않고" 정적으로 검사해 결함을 객관적으로 잡는다.
 * self-critique(같은 모델의 자기검토)와 달리 모델 맹점과 무관한 지상검증이다.
 *
 *  - Python: ruff(E9 문법 + F 미정의이름/import누락/미사용) + bandit(보안 스멜)
 *  - Node/JS: `node --check`(문법)
 *
 * 코드는 OS 임시 디렉터리에 UTF-8 파일로 쓰고 호스트 도구로 검사한다
 * (stdin 경유 시 Windows 콘솔 인코딩이 한글 주석을 깨뜨리는 문제 회피).
 * 정적 분석은 코드를 실행하지 않으므로 OH_SANDBOX 격리 플래그와 무관하게 안전하다.
 * ruff/bandit 미설치 시 `python -m py_compile`(문법만)로 폴백한다.
 *
 * env:
 *   OH_CODEGATE   on/off   (기본 on)
 *   OH_PY         파이썬 실행기 (기본 python)
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function codegateEnabled() {
  return (process.env.OH_CODEGATE ?? 'on').toLowerCase() !== 'off';
}
const PY = () => process.env.OH_PY || 'python';

// ── 코드블록 추출 (execverify의 펜스 파서와 동일 규칙, 정적검사 대상 언어만) ──
const LANG = {
  python: 'python', py: 'python', python3: 'python',
  node: 'node', javascript: 'node', js: 'node', mjs: 'node',
};
export function extractCodeBlocks(answer) {
  const text = (answer ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const re = /```([A-Za-z0-9+_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = LANG[(m[1] || '').toLowerCase()];
    const code = m[2].replace(/\s+$/, '');
    if (lang && code.trim()) out.push({ lang, code });
  }
  return out;
}

// ── 호스트 도구 가용성 탐지(1회 캐시) ──
let _caps = null;
function hostHasPyModule(mod) {
  try {
    const r = spawnSync(PY(), ['-m', mod, '--version'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}
function caps() {
  if (_caps) return _caps;
  _caps = { ruff: hostHasPyModule('ruff'), bandit: hostHasPyModule('bandit') };
  return _caps;
}

// ruff 코드: error 로 올리는 것(문법 E9xx, 미정의이름 F821, 재정의 F811, 미해결 import F822 등).
const RUFF_ERROR = /^(E9|F82[0-9]|F811|F706|F704|F501|F502|F503|F504|F505|F506|F507|F508|F509)/;

function run(cmd, args, { input, timeout = 20000 } = {}) {
  return spawnSync(cmd, args, { input, timeout, encoding: 'utf8', windowsHide: true });
}

function lintPython(code, dir) {
  const c = caps();
  if (!c.ruff && !c.bandit) return compilePython(code);           // 폴백: 문법만
  const file = join(dir, 'snippet.py');
  writeFileSync(file, code, 'utf8');                              // UTF-8 파일 → 인코딩 안전
  const findings = [];
  if (c.ruff) {
    const r = run(PY(), ['-m', 'ruff', 'check', '--output-format=json', '--select=E9,F', '--isolated', file]);
    try {
      for (const d of JSON.parse(r.stdout || '[]')) {
        findings.push({ tool: 'ruff', code: d.code, severity: RUFF_ERROR.test(d.code || '') ? 'error' : 'warn', line: d.location?.row, msg: d.message });
      }
    } catch { /* 파싱 실패 무시 */ }
  }
  if (c.bandit) {
    const r = run(PY(), ['-m', 'bandit', '-f', 'json', '-q', file]);
    try {
      for (const d of (JSON.parse(r.stdout || '{}').results || [])) {
        // bandit은 '취약점 존재'를 알려주는 보안 스멜 → 레드팀 PoC에선 '정보'로만(error 아님).
        findings.push({ tool: 'bandit', code: d.test_id, severity: 'info', line: d.line_number, msg: `${d.issue_text} [${d.issue_severity}]` });
      }
    } catch { /* */ }
  }
  return findings;
}

// 폴백: py_compile(문법만). 파일 경유로 인코딩 안전.
function compilePython(code) {
  const dir = mkdtempSync(join(tmpdir(), 'ohgate-'));
  const file = join(dir, 's.py');
  try {
    writeFileSync(file, code, 'utf8');
    const r = run(PY(), ['-X', 'utf8', '-c', `import py_compile,sys\ntry:\n py_compile.compile(r'''${file.replace(/\\/g, '\\\\')}''',doraise=True)\nexcept Exception as e:\n print(e,file=sys.stderr);sys.exit(1)`]);
    return r.status === 0 ? [] : [{ tool: 'py_compile', code: 'E999', severity: 'error', msg: (r.stderr || '').trim().split('\n').slice(-1)[0] }];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function checkNode(code, dir) {
  const file = join(dir, 'snippet.mjs');
  writeFileSync(file, code, 'utf8');
  const r = run('node', ['--check', file]);
  return r.status === 0 ? [] : [{ tool: 'node', code: 'SyntaxError', severity: 'error', msg: (r.stderr || '').trim().split('\n').slice(0, 2).join(' ').slice(0, 160) }];
}

/**
 * 답변 전체를 게이트한다.
 * 반환: { enabled, blocks, pass, findings:[{block,lang,tool,code,severity,line,msg}], backend }
 *   pass = severity 'error' 결함이 하나도 없음.
 */
export function gateAnswer(answer) {
  if (!codegateEnabled()) return { enabled: false, pass: true, findings: [], blocks: 0 };
  const blocks = extractCodeBlocks(answer);
  if (blocks.length === 0) return { enabled: true, pass: true, findings: [], blocks: 0, backend: 'none' };

  const c = caps();
  const backend = c.ruff ? (c.bandit ? 'ruff+bandit' : 'ruff') : 'py_compile';
  const dir = mkdtempSync(join(tmpdir(), 'ohgate-'));
  const findings = [];
  try {
    blocks.forEach((b, i) => {
      const fs = b.lang === 'python' ? lintPython(b.code, dir) : checkNode(b.code, dir);
      for (const f of fs) findings.push({ block: i + 1, lang: b.lang, ...f });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const pass = !findings.some(f => f.severity === 'error');
  return { enabled: true, pass, findings, blocks: blocks.length, backend };
}

/** 모델에 되먹일 수정 지시 텍스트(self-repair 루프용). error만 간결히. */
export function findingsToFeedback(gate) {
  const errs = gate.findings.filter(f => f.severity === 'error');
  if (!errs.length) return '';
  const lines = errs.map(f => `- [블록 ${f.block}/${f.lang}] ${f.tool} ${f.code}${f.line ? ` (line ${f.line})` : ''}: ${f.msg}`);
  return `정적 검증에서 다음 결함이 발견됐다. 코드를 수정해 다시 완전판으로 출력하라(설명 최소화):\n${lines.join('\n')}`;
}

/**
 * runAgentTurn 의 `verify` 콜백 어댑터. 정적 게이트(L1)를 {pass,feedback}로 변환한다.
 * 선택적으로 extra(예: 실행검증 L2)를 받아 추가 결함을 합친다.
 *   extra: async (content) => { pass:boolean, feedback?:string } | null
 * 반환: async (content) => { pass, feedback, gate }
 */
export function makeCodeVerify({ extra = null } = {}) {
  return async (content) => {
    const gate = gateAnswer(content);
    let pass = gate.pass;
    let feedback = findingsToFeedback(gate);
    if (extra) {
      try {
        const e = await extra(content);
        if (e && e.pass === false) { pass = false; if (e.feedback) feedback = [feedback, e.feedback].filter(Boolean).join('\n'); }
      } catch { /* 실행검증 실패는 L1 결과 유지 */ }
    }
    return { pass, feedback, gate };
  };
}
