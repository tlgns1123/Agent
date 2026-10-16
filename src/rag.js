import DB from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { embed } from './ollama.js';

// ─── 설정 ────────────────────────────────────────────────────────────────────
// 전역 보안 지식베이스 — 프로젝트와 무관하므로 홈 디렉터리에 둔다.
// 저장 분리: SQLite=메타데이터/본문/FTS5(BM25), LanceDB=벡터(ANN). 대규모(100GB)서 검색이
// 전체 스캔 없이 sub-linear로 동작하도록 디스크기반 ANN 사용.
const RAG_DIR    = process.env.OH_RAG_DIR   || join(homedir(), '.oh');
const DB_PATH    = join(RAG_DIR, 'knowledge.db');
const LANCE_DIR  = join(RAG_DIR, 'lancedb');
const EMBED_MODEL = process.env.OH_EMBED_MODEL || 'bge-m3';

// 청킹 파라미터 (한/영/코드 혼합 기준 char 휴리스틱, ~512토큰 ≈ 1500자)
const CHUNK_CHARS   = 1500;
const CHUNK_OVERLAP = 200;

// 출처 신뢰등급: 1=공식권위(NVD/MITRE/CISA/벤더), 2=정평커뮤니티(OWASP/HackTricks/ExploitDB), 3=일반/기타
export const TIER = { OFFICIAL: 1, COMMUNITY: 2, GENERAL: 3 };
export const TIER_LABEL = { 1: '공식', 2: '커뮤니티', 3: '일반' };

let _db = null;

function db() {
  if (_db) return _db;
  mkdirSync(RAG_DIR, { recursive: true });
  _db = new DB(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      title       TEXT,
      added_at    TEXT NOT NULL,
      source_tier INTEGER DEFAULT 3
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading     TEXT,
      body        TEXT NOT NULL,
      embedding   BLOB NOT NULL,
      dim         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    -- BM25 키워드 검색용 FTS5 (하이브리드 검색). chunk_id로 chunks와 연결.
    -- 도구명·CVE·플래그·숫자 등 정확매치는 BM25가 강함 → 벡터 의미검색을 보완.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, body);
  `);
  // 마이그레이션: 기존 DB에 출처 신뢰등급 컬럼 추가 (tier1=공식권위, 2=정평커뮤니티, 3=일반).
  const docCols = _db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  if (!docCols.includes('source_tier')) {
    _db.exec('ALTER TABLE documents ADD COLUMN source_tier INTEGER DEFAULT 3');
  }

  // 임베딩 모델 기록 — 모델이 바뀌면 차원이 달라져 재색인이 필요하므로 감지용.
  const stored = _db.prepare('SELECT value FROM meta WHERE key = ?').get('embed_model');
  if (!stored) {
    _db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('embed_model', EMBED_MODEL);
  } else if (stored.value !== EMBED_MODEL) {
    // 모델 불일치는 치명적이지 않지만 검색품질이 깨지므로 경고만 남긴다(재색인은 /rag reindex).
    process.stderr.write(`  ⚠ RAG 임베딩 모델 불일치: DB=${stored.value}, 현재=${EMBED_MODEL}. '/rag reindex' 권장.\n`);
  }
  return _db;
}

// ─── Float32 ↔ BLOB ──────────────────────────────────────────────────────────
function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}
function blobToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ─── LanceDB 벡터 스토어 (ANN, 디스크기반) ────────────────────────────────────
let _lance = null, _vtbl = null, _migrated = false;
const VEC_TABLE = 'vectors';   // { chunk_id: int, vector: float32[dim] }

async function lanceConn() {
  if (!_lance) { mkdirSync(RAG_DIR, { recursive: true }); _lance = await lancedb.connect(LANCE_DIR); }
  return _lance;
}

async function vecTableOrNull() {
  if (_vtbl) return _vtbl;
  const conn = await lanceConn();
  const names = await conn.tableNames();
  if (!names.includes(VEC_TABLE)) return null;
  _vtbl = await conn.openTable(VEC_TABLE);
  return _vtbl;
}

// 벡터 추가. 테이블 없으면 데이터로 생성(스키마 추론).
async function addVectors(rows) {
  if (!rows.length) return;
  const conn = await lanceConn();
  const t = await vecTableOrNull();
  if (t) await t.add(rows);
  else _vtbl = await conn.createTable(VEC_TABLE, rows);
}

async function deleteVectors(chunkIds) {
  if (!chunkIds.length) return;
  const t = await vecTableOrNull();
  if (t) await t.delete(`chunk_id IN (${chunkIds.join(',')})`);
}

// ANN 코사인 검색 → [{ chunk_id, cosine }]
async function searchVectors(qvec, k) {
  const t = await vecTableOrNull();
  if (!t) return [];
  const res = await t.search(Array.from(qvec)).distanceType('cosine').limit(k).toArray();
  return res.map(r => ({ chunk_id: r.chunk_id, cosine: 1 - r._distance }));
}

// 기존 SQLite BLOB을 LanceDB로 1회 이전(구버전 DB 호환). meta 플래그로 1회만.
async function ensureMigrated() {
  if (_migrated) return;
  const conn = db();
  if (conn.prepare("SELECT 1 FROM meta WHERE key='lance_migrated'").get()) { _migrated = true; return; }
  const rows = conn.prepare('SELECT id, embedding FROM chunks').all();
  if (rows.length && !(await vecTableOrNull())) {
    process.stderr.write(`  ⏳ 벡터 인덱스 이전(LanceDB) ${rows.length}건…\n`);
    const batch = 1000;
    for (let i = 0; i < rows.length; i += batch) {
      await addVectors(rows.slice(i, i + batch).map(r => ({ chunk_id: r.id, vector: Array.from(blobToVec(r.embedding)) })));
    }
  }
  conn.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('lance_migrated','1')").run();
  _migrated = true;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── 구조 인식 청킹 ───────────────────────────────────────────────────────────
// 마크다운 헤딩(#) 경계로 섹션을 나누고, 섹션이 크면 오버랩 윈도우로 재분할한다.
// 각 청크는 소속 헤딩을 메타로 갖는다(인용·문맥 복원용).
export function chunkText(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let curHeading = '';
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading: curHeading, body });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      curHeading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  // 섹션이 없으면(헤딩 전무) 전체를 한 섹션으로
  if (sections.length === 0 && text.trim()) {
    sections.push({ heading: '', body: text.trim() });
  }

  const chunks = [];
  for (const sec of sections) {
    for (const piece of splitWithOverlap(sec.body, CHUNK_CHARS, CHUNK_OVERLAP)) {
      chunks.push({ heading: sec.heading, body: piece });
    }
  }
  return chunks;
}

// 큰 텍스트를 문단 경계 우선으로 윈도우 분할(오버랩 포함).
function splitWithOverlap(text, size, overlap) {
  if (text.length <= size) return [text];
  const paras = text.split(/\n{2,}/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > size) {
      out.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap)) + '\n\n' + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
    // 한 문단 자체가 size보다 크면 강제 절단
    while (cur.length > size) {
      out.push(cur.slice(0, size).trim());
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 견고한 임베딩: 배치 1회 시도 → 실패하거나 NaN 섞이면 청크별로 재시도해 정상만 남김.
// 반환: [[원본인덱스, 벡터], ...] (실패/NaN 청크는 빠짐). bge-m3가 특정 입력에 NaN 반환하는 문제 대응.
const hasNaN = v => !v || v.some(Number.isNaN);
async function embedResilient(bodies, signal) {
  try {
    const vs = await embed({ model: EMBED_MODEL, input: bodies, signal });
    if (vs.length === bodies.length && !vs.some(hasNaN)) return vs.map((v, i) => [i, v]);
  } catch { /* 배치 실패 → 폴백 */ }
  const out = [];
  for (let i = 0; i < bodies.length; i++) {
    try {
      const [v] = await embed({ model: EMBED_MODEL, input: bodies[i], signal });
      if (!hasNaN(v)) out.push([i, v]);
    } catch { /* 이 청크만 건너뜀 */ }
  }
  return out;
}

// ─── 적재 / 검색 ──────────────────────────────────────────────────────────────
/**
 * 문서 하나를 청킹·임베딩해 KB에 적재. { docId, chunks } 반환.
 * source 가 이미 있으면 기존 문서를 교체(재적재).
 */
export async function addDocument({ source, title = null, text, tier = TIER.GENERAL, signal } = {}) {
  if (!text?.trim()) throw new Error('빈 문서');
  const conn = db();

  // 빈/공백 청크 제거(bge-m3가 NaN 임베딩 반환하는 원인)
  const chunks = chunkText(text).filter(c => c.body.trim().length > 0);
  if (chunks.length === 0) throw new Error('청크 생성 실패');

  await ensureMigrated();

  // 견고한 임베딩: 배치 실패/NaN이면 청크별 폴백 → 나쁜 청크만 건너뜀(문서 전체 실패 방지).
  const kept = await embedResilient(chunks.map(c => c.body), signal);   // [[idx, vector], ...]
  if (kept.length === 0) throw new Error('임베딩 가능한 청크 없음');
  const okChunks = kept.map(([i]) => chunks[i]);
  const vectors  = kept.map(([, v]) => v);
  const dim = vectors[0].length;

  const newIds = [];
  let oldIds = [];
  const tx = conn.transaction(() => {
    // 같은 source 재적재 시 기존 것 제거
    const existing = conn.prepare('SELECT id FROM documents WHERE source = ?').get(source);
    if (existing) {
      oldIds = conn.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(existing.id).map(r => r.id);
      for (const id of oldIds) conn.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(id);
      conn.prepare('DELETE FROM chunks WHERE doc_id = ?').run(existing.id);
      conn.prepare('DELETE FROM documents WHERE id = ?').run(existing.id);
    }
    const { lastInsertRowid: docId } = conn
      .prepare('INSERT INTO documents (source, title, added_at, source_tier) VALUES (?, ?, ?, ?)')
      .run(source, title, new Date().toISOString(), tier);
    const ins = conn.prepare(
      'INSERT INTO chunks (doc_id, chunk_index, heading, body, embedding, dim) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insFts = conn.prepare('INSERT INTO chunks_fts (chunk_id, body) VALUES (?, ?)');
    okChunks.forEach((c, i) => {
      const { lastInsertRowid } = ins.run(docId, i, c.heading, c.body, vecToBlob(vectors[i]), dim);
      insFts.run(lastInsertRowid, c.body);
      newIds.push(Number(lastInsertRowid));
    });
    return docId;
  });
  const docId = tx();

  // LanceDB 벡터 동기화 (재적재면 기존 벡터 제거 후 추가)
  if (oldIds.length) await deleteVectors(oldIds);
  await addVectors(newIds.map((id, i) => ({ chunk_id: id, vector: Array.from(vectors[i]) })));

  return { docId, chunks: okChunks.length };
}

// chunk_id 목록으로 SQLite 메타데이터를 가져와 Map 반환.
function fetchChunks(conn, ids) {
  if (!ids.length) return new Map();
  const rows = conn.prepare(`
    SELECT c.id, c.body, c.heading, c.chunk_index, d.source, d.title, d.source_tier
    FROM chunks c JOIN documents d ON d.id = c.doc_id
    WHERE c.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  return new Map(rows.map(r => [r.id, r]));
}

/**
 * 쿼리로 top-k 청크 검색 (LanceDB ANN 벡터). 전체 스캔 없이 sub-linear.
 * 반환: [{ score, source, title, tier, heading, body, chunk_index }]
 */
export async function search(query, { topK = 5, minScore = 0 } = {}) {
  await ensureMigrated();
  const conn = db();
  const [qv] = await embed({ model: EMBED_MODEL, input: query });
  const hits = await searchVectors(qv, topK * 4);
  if (hits.length === 0) return [];
  const meta = fetchChunks(conn, hits.map(h => h.chunk_id));
  return hits
    .map(h => {
      const m = meta.get(h.chunk_id);
      return m && { score: h.cosine, source: m.source, title: m.title, tier: m.source_tier, heading: m.heading, body: m.body, chunk_index: m.chunk_index };
    })
    .filter(r => r && r.score >= minScore)
    .slice(0, topK);
}

// ─── 하이브리드 검색 (BM25 + 벡터, RRF 융합) ──────────────────────────────────
// 벡터=의미 유사도(동의어·의역에 강함), BM25=정확 토큰매치(도구명·CVE·플래그·숫자에 강함).
// 둘의 순위를 Reciprocal Rank Fusion으로 합쳐 단독보다 견고한 랭킹을 만든다(스케일 무관).
const RRF_K          = 60;
const COSINE_FLOOR   = 0.5;    // 의미 단독으로 근거 인정하는 최소 코사인
const BM25_COS_FLOOR = 0.35;   // 키워드 매치 시 요구하는 최소 의미정렬(불용어 오매치 차단)

// ─── 리랭커 (cross-encoder, transformers.js / 순수 Node) ──────────────────────
// Ollama엔 rerank 엔드포인트가 없어(2026 확인) ONNX cross-encoder를 Node에서 직접 구동.
// 하이브리드 후보를 (query,doc) 쌍으로 재채점 → 정확매치를 확실히 1위로. 로드 실패 시 graceful fallback.
const RERANK_ENABLED = (process.env.OH_RERANK || 'on').toLowerCase() !== 'off';
const RERANK_MODEL   = process.env.OH_RERANK_MODEL || 'onnx-community/bge-reranker-v2-m3-ONNX';
const RERANK_DTYPE   = process.env.OH_RERANK_DTYPE || 'q8';
const RERANK_FLOOR   = Number(process.env.OH_RERANK_FLOOR ?? -2); // logit 바닥값(무관 질의 차단)
// 재채점할 후보 수(검색 폭 candidates와 분리). Phase5 실측: 후보30 재채점이 쿼리당 ~수초 CPU비용인데
// RRF recall@10=100% → 상위 10개만 재채점해도 품질 손실 없이 지연 ~3배↓. env OH_RERANK_TOPN(기본 10).
const RERANK_TOPN    = Math.max(1, parseInt(process.env.OH_RERANK_TOPN ?? '10', 10) || 10);

let _reranker = null;  // { tok, model } | 'failed' | null

async function getReranker() {
  if (!RERANK_ENABLED || _reranker === 'failed') return null;
  if (_reranker) return _reranker;
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
    process.stderr.write('  ⏳ 리랭커 로딩(최초 1회, 캐시됨)…\n');
    const tok   = await AutoTokenizer.from_pretrained(RERANK_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: RERANK_DTYPE });
    _reranker = { tok, model };
    return _reranker;
  } catch (e) {
    process.stderr.write(`  ⚠ 리랭커 비활성(로드 실패: ${e.message}) — 하이브리드로 진행\n`);
    _reranker = 'failed';
    return null;
  }
}

// (query, doc[]) → logit 점수[] (높을수록 관련). 리랭커 없으면 null.
async function rerankScores(query, docs) {
  const rr = await getReranker();
  if (!rr || docs.length === 0) return null;
  const inputs = rr.tok(docs.map(() => query), { text_pair: docs, padding: true, truncation: true });
  const { logits } = await rr.model(inputs);
  return Array.from(logits.data);
}

// FTS5가 비어 있는데 청크는 있으면(구버전 DB) 재구축
function ensureFts(conn) {
  const ftsN   = conn.prepare('SELECT COUNT(*) n FROM chunks_fts').get().n;
  const chunkN = conn.prepare('SELECT COUNT(*) n FROM chunks').get().n;
  if (ftsN === 0 && chunkN > 0) {
    const insFts = conn.prepare('INSERT INTO chunks_fts (chunk_id, body) VALUES (?, ?)');
    const rows = conn.prepare('SELECT id, body FROM chunks').all();
    conn.transaction(() => rows.forEach(r => insFts.run(r.id, r.body)))();
  }
}

// 자유 질의를 FTS5 MATCH 식으로 변환: 토큰을 OR로 묶고 각 토큰을 인용(특수문자 안전).
// 길이 2+ 토큰은 유지하되, 숫자(예: "0","5600" 같은 모드/포트/CVE 번호)는 1자리도 유지 —
// 정확매치 disambiguation의 핵심 신호라 버리면 안 됨. 한글 1자 조사(은/는/이/가)는 자연히 탈락.
function ftsQuery(q) {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length >= 2 || /^\d+$/.test(t));
  if (tokens.length === 0) return null;
  return [...new Set(tokens)].map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export async function searchHybrid(query, { topK = 5, candidates = 30, rerank = RERANK_ENABLED } = {}) {
  await ensureMigrated();
  const conn = db();
  ensureFts(conn);

  // 1) 벡터 후보 (LanceDB ANN — 전체 스캔 없음)
  const [qv] = await embed({ model: EMBED_MODEL, input: query });
  const vecHits = await searchVectors(qv, candidates);   // [{chunk_id, cosine}]
  const vecRank = new Map(vecHits.map((h, i) => [h.chunk_id, i + 1]));
  const cosById = new Map(vecHits.map(h => [h.chunk_id, h.cosine]));

  // 2) BM25 후보 (키워드 정확매치). bm25()는 작을수록 좋음.
  const bmRank = new Map(), bm25ById = new Map();
  const fq = ftsQuery(query);
  if (fq) {
    const bm = conn.prepare(
      'SELECT chunk_id, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?'
    ).all(fq, candidates);
    bm.forEach((r, i) => { bmRank.set(r.chunk_id, i + 1); bm25ById.set(r.chunk_id, r.s); });
  }

  // 후보 합집합의 메타데이터만 SQLite에서 조회(전체 스캔 회피)
  const ids = [...new Set([...vecRank.keys(), ...bmRank.keys()])];
  if (ids.length === 0) return [];
  const meta = fetchChunks(conn, ids);

  // 3) RRF 융합으로 후보 순위 결정.
  const fused = ids.map(id => {
    const m = meta.get(id);
    if (!m) return null;
    const rrf = (vecRank.has(id) ? 1 / (RRF_K + vecRank.get(id)) : 0)
              + (bmRank.has(id)  ? 1 / (RRF_K + bmRank.get(id))  : 0);
    return {
      id, cosine: cosById.get(id) ?? 0, bm25: bm25ById.get(id) ?? null,
      source: m.source, title: m.title, tier: m.source_tier,
      heading: m.heading, body: m.body, chunk_index: m.chunk_index,
      score: cosById.get(id) ?? 0, rrf,
    };
  }).filter(Boolean).sort((a, b) => b.rrf - a.rrf);

  // 4) 리랭커: 후보 풀을 cross-encoder로 재채점 → 정확매치를 1위로. 게이트는 리랭커 점수로.
  if (rerank) {
    const pool = fused.slice(0, Math.min(RERANK_TOPN, candidates));
    const scores = await rerankScores(query, pool.map(it => it.body));
    if (scores) {
      pool.forEach((it, i) => { it.rerank = scores[i]; });
      return pool
        .filter(it => it.rerank >= RERANK_FLOOR)
        .sort((a, b) => b.rerank - a.rerank)
        .slice(0, topK);
    }
    // 리랭커 미가용 → 아래 하이브리드 게이트로 폴백
  }

  // 게이트: 의미(코사인≥0.5) 또는 키워드매치(+코사인≥0.35)만 근거로 인정.
  return fused
    .filter(it => it.cosine >= COSINE_FLOOR || (it.bm25 != null && it.cosine >= BM25_COS_FLOOR))
    .slice(0, topK);
}

// 멀티쿼리 확장 검색: 한 질문을 여러 각도 쿼리로 분해해 각각 하이브리드 후보를 모으고,
// 합집합(중복 제거) 후 "원 질문" 기준으로 cross-encoder 재채점해 상위 topK를 반환한다.
// 7B의 좁은 사고를 검색 다양성으로 보완(넓은 사고). 쿼리 확장(모델호출)은 호출자가 담당.
export async function searchMulti(queries, { topK = 5, candidates = 30, rerank = RERANK_ENABLED, primary } = {}) {
  const qs = [...new Set((queries || []).map(q => (q || '').trim()).filter(Boolean))];
  if (qs.length === 0) return [];
  if (qs.length === 1) return searchHybrid(qs[0], { topK, candidates, rerank });

  // 각 각도 쿼리에서 후보만 수집(재채점은 뒤에서 한 번만) → chunk id로 합집합, 최대 rrf 유지
  const byId = new Map();
  for (const q of qs) {
    let hits = [];
    try { hits = await searchHybrid(q, { topK: candidates, candidates, rerank: false }); }
    catch { hits = []; }
    for (const h of hits) {
      const prev = byId.get(h.id);
      if (!prev || h.rrf > prev.rrf) byId.set(h.id, h);
    }
  }
  const pool = [...byId.values()];
  if (pool.length === 0) return [];

  const primaryQ = (primary && primary.trim()) || qs[0];
  if (rerank) {
    // 재채점 비용 상한: 합집합 pool이 멀티쿼리로 커질 수 있으므로 RRF 상위 RERANK_TOPN개만 교차인코더에 올림.
    const rpool = [...pool].sort((a, b) => b.rrf - a.rrf).slice(0, RERANK_TOPN);
    const scores = await rerankScores(primaryQ, rpool.map(it => it.body));
    if (scores) {
      rpool.forEach((it, i) => { it.rerank = scores[i]; });
      return rpool
        .filter(it => it.rerank >= RERANK_FLOOR)
        .sort((a, b) => b.rerank - a.rerank)
        .slice(0, topK);
    }
  }
  // 리랭커 미가용 → RRF 융합순
  return pool.sort((a, b) => b.rrf - a.rrf).slice(0, topK);
}

export function stats() {
  const conn = db();
  const docs   = conn.prepare('SELECT COUNT(*) n FROM documents').get().n;
  const chunks = conn.prepare('SELECT COUNT(*) n FROM chunks').get().n;
  const model  = conn.prepare('SELECT value FROM meta WHERE key = ?').get('embed_model')?.value;
  return { docs, chunks, model, dbPath: DB_PATH };
}

export function listDocuments() {
  return db().prepare(`
    SELECT d.id, d.source, d.title, d.added_at, d.source_tier, COUNT(c.id) AS chunks
    FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id
    GROUP BY d.id ORDER BY d.added_at DESC
  `).all();
}

export async function removeDocument(source) {
  const conn = db();
  const doc = conn.prepare('SELECT id FROM documents WHERE source = ? OR id = ?').get(source, source);
  if (!doc) return false;
  const ids = conn.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(doc.id).map(r => r.id);
  for (const id of ids) conn.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(id);
  conn.prepare('DELETE FROM chunks WHERE doc_id = ?').run(doc.id);
  conn.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  await deleteVectors(ids);
  return true;
}

// 기존 청크 본문을 현재 임베딩 모델로 다시 임베딩(모델 교체 후 복구용).
export async function reindexAll({ signal } = {}) {
  const conn = db();
  const rows = conn.prepare('SELECT id, body FROM chunks').all();
  if (rows.length === 0) return { reindexed: 0 };
  const vectors = await embed({ model: EMBED_MODEL, input: rows.map(r => r.body), signal });
  const upd = conn.prepare('UPDATE chunks SET embedding = ?, dim = ? WHERE id = ?');
  conn.transaction(() => rows.forEach((r, i) => upd.run(vecToBlob(vectors[i]), vectors[i].length, r.id)))();
  // LanceDB 벡터 교체
  await deleteVectors(rows.map(r => r.id));
  const batch = 1000;
  for (let i = 0; i < rows.length; i += batch) {
    await addVectors(rows.slice(i, i + batch).map((r, j) => ({ chunk_id: r.id, vector: Array.from(vectors[i + j]) })));
  }
  conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('embed_model', EMBED_MODEL);
  return { reindexed: rows.length };
}

export async function clearAll() {
  const conn = db();
  conn.exec('DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM documents;');
  const lc = await lanceConn();
  if ((await lc.tableNames()).includes(VEC_TABLE)) { await lc.dropTable(VEC_TABLE); _vtbl = null; }
}

export { EMBED_MODEL, DB_PATH };
