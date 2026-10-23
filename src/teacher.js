/**
 * OH — 교사 루프 (teacher loop)
 *
 * 자가검증 3층(L1 정적·L2 실행·템플릿)이 못 잡는 '논리/구조' 버그를, 강한 외부 교사(Claude)가
 * 배치 리뷰·교정해 그 결과를 데이터로 적립하고 모델에 되먹이는 순환.
 *
 *   ① 수집(자동)  : 코드 생성 턴 중 'L1 통과 + 코드 포함'(= 논리 리뷰 후보)을 큐에 적재
 *   ② 교정(사람)  : 교사가 큐를 읽고 틀린 부분을 정답 버전으로 고침  ← CLI로 기록
 *   ③ 적립(자동)  : (rejected=원본, chosen=교정) 교정쌍을 corrections.jsonl에 저장
 *   ④ 주입(자동)  : (a) chosen을 템플릿 코퍼스로 적재(즉효)  (b) DPO 쌍으로 export(누적 후 재학습)
 *
 * 핵심 제약: ②는 교사 세션이 필요(완전 오프라인 자동 아님). 나머지는 자동.
 *
 * 저장소: ~/.oh/teacher/{queue.jsonl, corrections.jsonl}  (OH_TEACHER_DIR 로 변경)
 * env: OH_TEACHER  on/off  (수집 활성, 기본 on)
 *
 * CLI:  node src/teacher.js <list|show <id>|correct <id> --file <f> [--category c] [--note n] [--lang l]
 *                            |ingest [<id>]|export-dpo [<out>]|stats>
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { gateAnswer, extractCodeBlocks } from './codegate.js';

const DIR = process.env.OH_TEACHER_DIR || join(homedir(), '.oh', 'teacher');
const QUEUE = join(DIR, 'queue.jsonl');
const CORR  = join(DIR, 'corrections.jsonl');

export function teacherEnabled() {
  return (process.env.OH_TEACHER ?? 'on').toLowerCase() !== 'off';
}
function ensureDir() { mkdirSync(DIR, { recursive: true }); }
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function writeJsonl(path, rows) {
  ensureDir();
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

// ── ① 수집 ──────────────────────────────────────────────────────────────────
// 코드 산출물을 폭넓게 수집한다:
//   (a) 최종 답변의 코드블록  (b) write_file/edit_file로 쓴 파일 코드  (c) run_code/run_command 실행
// 중요: L1/self-repair는 최종 답변 텍스트만 검사 → 파일로 쓴 코드는 정적검사를 안 받으므로,
//       여기서 파일 코드에도 L1을 돌려 크래시 상태를 큐에 남긴다(교사 리뷰 시 참고).

const MAXCODE = 8000, MAXERR = 1200;
const EXT_LANG = { py: 'python', js: 'node', mjs: 'node', ts: 'node', sh: 'shell', bash: 'shell' };
const langOfPath = (p) => EXT_LANG[(p || '').split('.').pop()?.toLowerCase()] || 'text';

// 턴의 tool 활동에서 코드/실행/읽기 산출물을 정규화한다.
// tools: [{ name, params, result }]
function normalizeTools(tools = []) {
  const out = [];
  for (const t of tools) {
    const p = t.params || {}, r = t.result || {};
    if (t.name === 'write_file' && p.content) {
      out.push({ kind: 'write', path: p.path, lang: langOfPath(p.path), code: String(p.content).slice(0, MAXCODE) });
    } else if (t.name === 'edit_file') {
      const code = p.edits?.length ? p.edits.map(e => e.new_string).join('\n') : (p.new_string ?? '');
      if (code) out.push({ kind: 'edit', path: p.path, lang: langOfPath(p.path), code: String(code).slice(0, MAXCODE) });
    } else if (t.name === 'run_code' && p.code) {
      out.push({ kind: 'run', lang: p.language || 'python', code: String(p.code).slice(0, MAXCODE),
        success: r.success, exit_code: r.exit_code, stderr: String(r.stderr || r.error || '').slice(0, MAXERR) });
    } else if (t.name === 'run_command' && p.command) {
      out.push({ kind: 'run', lang: 'shell', code: String(p.command).slice(0, MAXCODE),
        success: r.success, exit_code: r.exit_code, stderr: String(r.stderr || r.error || '').slice(0, MAXERR) });
    } else if (t.name === 'read_file' && p.path) {
      out.push({ kind: 'read', path: p.path });
    }
  }
  return out;
}

// 수집 대상 코드 조각(답변 블록 + 파일/실행 코드). L1 상태 요약 포함.
function collectArtifacts(answer, norm) {
  const arts = [];
  for (const b of extractCodeBlocks(answer)) arts.push({ origin: 'answer', lang: b.lang, code: b.code });
  for (const t of norm) if (t.code && (t.kind === 'write' || t.kind === 'edit' || t.kind === 'run')) {
    arts.push({ origin: t.kind, lang: t.lang, code: t.code, path: t.path });
  }
  return arts;
}

export function shouldEnqueue(answer, tools = []) {
  if (!teacherEnabled()) return false;
  const norm = normalizeTools(tools);
  const hasCode = collectArtifacts(answer, norm).length > 0;
  const failedRun = norm.some(t => t.kind === 'run' && t.success === false);
  return hasCode || failedRun;   // 코드 산출물 또는 실행 실패 = 리뷰 가치
}

export function enqueue({ model, prompt, answer = '', tools = [] }) {
  try {
    if (!shouldEnqueue(answer, tools)) return null;
    ensureDir();
    const norm = normalizeTools(tools);
    const arts = collectArtifacts(answer, norm);
    // 각 코드 조각 L1 게이트(파일 코드 포함) → 크래시 상태 요약.
    const gated = arts.map(a => {
      const md = '```' + (a.lang === 'text' ? '' : a.lang) + '\n' + a.code + '\n```';
      const g = gateAnswer(md);
      return { origin: a.origin, path: a.path, lang: a.lang,
        l1_pass: g.pass, l1_errors: g.findings.filter(f => f.severity === 'error').map(f => `${f.code}${f.line ? ' L' + f.line : ''}`) };
    });
    const failedRun = norm.some(t => t.kind === 'run' && t.success === false);
    const entry = {
      id: 't_' + randomBytes(5).toString('hex'),
      ts: Date.now(), model, prompt: (prompt || '').slice(0, 2000), answer: (answer || '').slice(0, 12000),
      tools: norm, artifacts: gated,
      flags: { failed_run: failedRun, l1_fail: gated.some(a => !a.l1_pass) },
      reviewed: false,
    };
    appendFileSync(QUEUE, JSON.stringify(entry) + '\n', 'utf8');
    return entry.id;
  } catch { return null; }   // 수집 실패는 턴에 영향 주지 않음
}

export function loadQueue()       { return readJsonl(QUEUE); }
export function loadCorrections() { return readJsonl(CORR); }
export function pending()         { return loadQueue().filter(e => !e.reviewed); }

// ── ②→③ 교정 기록 ────────────────────────────────────────────────────────────
// 교사가 교정한 chosen(정답 코드/답변)을 기록. 원본은 큐에서 rejected로 끌어옴.
export function recordCorrection({ id, chosen, category = 'misc', note = '', lang = 'python' }) {
  const q = loadQueue();
  const item = q.find(e => e.id === id);
  if (!item) throw new Error(`큐에 없는 id: ${id}`);
  if (!chosen || !chosen.trim()) throw new Error('chosen(교정본)이 비어 있음');
  const corr = {
    id, ts: Date.now(), category, note, lang,
    prompt: item.prompt, rejected: item.answer, chosen,
  };
  ensureDir();
  appendFileSync(CORR, JSON.stringify(corr) + '\n', 'utf8');
  item.reviewed = true;
  writeJsonl(QUEUE, q);   // 큐 항목 reviewed 마킹
  return corr;
}

// ── ④a 템플릿 적재 ────────────────────────────────────────────────────────────
// 교정본(chosen)을 템플릿 .md로 만들어 L1 게이트 통과 시 KB에 적재(즉효 주입).
// chosen이 펜스 없는 순수 코드면 lang 펜스로 감싼다.
function asTemplateMarkdown(corr) {
  const hasFence = /```/.test(corr.chosen);
  const body = hasFence ? corr.chosen : '```' + corr.lang + '\n' + corr.chosen.replace(/\s+$/, '') + '\n```';
  const title = `[교정] ${corr.category} — ${(corr.note || corr.prompt).slice(0, 60)}`;
  return `# ${title}\n\n> 교사 교정본 (id ${corr.id}). 원 요청: ${corr.prompt.slice(0, 120)}\n` +
         (corr.note ? `> 교정 포인트: ${corr.note}\n` : '') + `\n${body}\n`;
}

export async function ingestCorrections(id = null) {
  const rows = loadCorrections().filter(c => !id || c.id === id);
  if (rows.length === 0) return { ingested: 0, chunks: 0, skipped: [] };
  const { addDocument, removeDocument, TIER } = await import('./rag.js');
  let ingested = 0, chunks = 0;
  const skipped = [];
  for (const c of rows) {
    const md = asTemplateMarkdown(c);
    const gate = gateAnswer(md);                       // L1: 교정본도 크래시 없어야 적재
    if (!gate.pass) { skipped.push({ id: c.id, reason: 'L1 실패', findings: gate.findings.filter(f => f.severity === 'error') }); continue; }
    const source = `oh-template:correction-${c.id}`;
    try { await removeDocument(source); } catch { /* 신규면 없음 */ }
    const r = await addDocument({ source, title: `[교정] ${c.category}`, text: md, tier: TIER.OFFICIAL });
    ingested++; chunks += r.chunks;
  }
  return { ingested, chunks, skipped };
}

// ── ④b DPO export ─────────────────────────────────────────────────────────────
// 누적 교정쌍을 oh-uncensor-ft DPO 포맷({prompt,chosen,rejected})으로 내보냄(재학습용).
export function exportDpo(outPath = null) {
  const out = outPath || join(DIR, 'dpo_export.jsonl');
  const rows = loadCorrections().map(c => ({ prompt: c.prompt, chosen: c.chosen, rejected: c.rejected }));
  ensureDir();
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { path: out, pairs: rows.length };
}

export function stats() {
  const q = loadQueue(), c = loadCorrections();
  return { queued: q.length, pending: q.filter(e => !e.reviewed).length, corrections: c.length, dir: DIR };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; }
  }
  return out;
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list') {
    const p = pending();
    if (!p.length) { console.log('리뷰 대기 없음.'); return; }
    for (const e of p) {
      const f = e.flags || {};
      const mark = f.failed_run ? '🔴실행실패' : f.l1_fail ? '🟠L1실패' : '🟢';
      console.log(`${e.id}  ${mark}  [${new Date(e.ts).toISOString().slice(0, 16)}]  ${(e.prompt || '').replace(/\s+/g, ' ').slice(0, 64)}`);
    }
    console.log(`\n대기 ${p.length}건.  (🔴/🟠 우선 리뷰 권장)`);
  } else if (cmd === 'show') {
    const e = loadQueue().find(x => x.id === rest[0]);
    if (!e) { console.log('없는 id'); return; }
    console.log(`# ${e.id}  flags=${JSON.stringify(e.flags || {})}\n## 요청\n${e.prompt}`);
    if (e.artifacts?.length) {
      console.log(`\n## 코드 산출물 (L1 상태)`);
      for (const a of e.artifacts) console.log(`  - [${a.origin}${a.path ? ' ' + a.path : ''}/${a.lang}] L1 ${a.l1_pass ? 'PASS' : 'FAIL ' + a.l1_errors.join(',')}`);
    }
    for (const t of (e.tools || [])) {
      if (t.kind === 'read') { console.log(`\n## read: ${t.path}`); continue; }
      const head = t.kind === 'run' ? `## 실행(${t.lang}) exit=${t.exit_code ?? '?'} success=${t.success}` : `## ${t.kind}: ${t.path || ''}`;
      console.log(`\n${head}`);
      if (t.code) console.log('```' + (t.lang === 'text' ? '' : t.lang) + '\n' + t.code + '\n```');
      if (t.stderr) console.log(`stderr: ${t.stderr}`);
    }
    if (e.answer?.trim()) console.log(`\n## 최종 답변\n${e.answer}`);
  } else if (cmd === 'correct') {
    const id = rest[0];
    const f = parseFlags(rest.slice(1));
    if (!f.file) { console.log('--file <교정본경로> 필요'); return; }
    const chosen = readFileSync(f.file, 'utf8');
    const corr = recordCorrection({ id, chosen, category: f.category, note: f.note, lang: f.lang || 'python' });
    console.log(`✓ 교정 기록: ${corr.id} (${corr.category}). corrections.jsonl 적립.`);
  } else if (cmd === 'ingest') {
    const r = await ingestCorrections(rest[0] || null);
    console.log(`✓ 템플릿 적재: ${r.ingested}건 / ${r.chunks}청크` + (r.skipped.length ? `  (L1실패 스킵 ${r.skipped.length})` : ''));
    for (const s of r.skipped) console.log(`   ⛔ ${s.id}: ${s.reason}`);
  } else if (cmd === 'export-dpo') {
    const r = exportDpo(rest[0] || null);
    console.log(`✓ DPO export: ${r.pairs}쌍 → ${r.path}`);
  } else if (cmd === 'stats') {
    console.log(JSON.stringify(stats(), null, 2));
  } else {
    console.log('사용: node src/teacher.js <list|show <id>|correct <id> --file <f> [--category c] [--note n]|ingest [<id>]|export-dpo [<out>]|stats>');
  }
}

// 직접 실행 시 CLI (import 시엔 미실행). argv[1]이 없을 수 있으므로 널세이프.
const _invoked = process.argv[1];
if (_invoked && (import.meta.url === `file://${_invoked.replace(/\\/g, '/')}` || _invoked.endsWith('teacher.js'))) {
  cli(process.argv.slice(2)).catch(e => { console.error('오류:', e.message); process.exit(1); });
}
