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
// 논리 리뷰 후보 조건: 코드블록 존재 + L1(정적) 통과(= 크래시류는 이미 self-repair가 처리,
// 남은 건 '맞냐'는 논리 판단). L1 실패분은 수집 안 함(자동 수리 대상).
export function shouldEnqueue(answer) {
  if (!teacherEnabled()) return false;
  const blocks = extractCodeBlocks(answer);
  if (blocks.length === 0) return false;
  const gate = gateAnswer(answer);
  return gate.pass === true;   // 크래시 없는 코드 → 논리 리뷰 가치
}

export function enqueue({ model, prompt, answer }) {
  try {
    if (!shouldEnqueue(answer)) return null;
    ensureDir();
    const entry = {
      id: 't_' + randomBytes(5).toString('hex'),
      ts: Date.now(), model, prompt: (prompt || '').slice(0, 2000), answer,
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
    for (const e of p) console.log(`${e.id}  [${new Date(e.ts).toISOString().slice(0, 16)}]  ${e.prompt.replace(/\s+/g, ' ').slice(0, 70)}`);
    console.log(`\n대기 ${p.length}건.`);
  } else if (cmd === 'show') {
    const e = loadQueue().find(x => x.id === rest[0]);
    if (!e) { console.log('없는 id'); return; }
    console.log(`# ${e.id}\n## 요청\n${e.prompt}\n\n## 답변(rejected 후보)\n${e.answer}`);
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

// 직접 실행 시 CLI (import 시엔 미실행)
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('teacher.js')) {
  cli(process.argv.slice(2)).catch(e => { console.error('오류:', e.message); process.exit(1); });
}
