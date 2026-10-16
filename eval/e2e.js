// OH Phase5 — 종단간(E2E) 답변 평가. 실제 모델을 돌린다(느림, 옵트인).
// 측정: 한글비율 · 핵심어 커버리지 · 지연(ms) · tok/s. num_ctx/모델 비교에 사용.
import { searchHybrid, stats } from '../src/rag.js';
import { streamChat } from '../src/ollama.js';
import { loadDataset, hangulRatio, keywordCoverage, isDegenerate, mean, fmt, pct, printTable } from './lib.js';

const MODEL   = process.env.OH_MODEL || 'hf.co/bartowski/WhiteRabbitNeo_WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M';
const NUM_CTX = parseInt(process.env.OH_EVAL_NUMCTX || '16384', 10);
const TOPK    = parseInt(process.env.OH_EVAL_TOPK || '5', 10);
const NUM_PRED = parseInt(process.env.OH_NUM_PREDICT || '4096', 10);   // 폭주 방지(프로덕션과 동일)

// index.js autoInjectRag 와 동일한 근거 블록을 구성(평가 일관성).
function buildGroundedMessage(topic, hits) {
  const TIER_LABEL = { 1: '공식', 2: '커뮤니티', 3: '일반' };
  const blocks = hits.map((h, i) => {
    const cite = h.heading ? `${h.source} › ${h.heading}` : h.source;
    return `[근거 ${i + 1}] (출처: ${cite}, 신뢰등급: ${TIER_LABEL[h.tier] ?? '일반'})\n${h.body}`;
  }).join('\n\n').replace(/\{/g, '｛').replace(/\}/g, '｝').slice(0, 10000);
  return `[지식베이스 근거 — "${topic.slice(0, 60)}"]\n` +
    `🚫 아래 근거에 있는 내용만 사용할 것. 근거에 없으면 "지식베이스에 없음"이라고 명시.\n` +
    `✅ 사용한 근거의 출처와 신뢰등급을 밝힐 것.\n⚠️ 반드시 한국어로 답변.\n\n${blocks}\n\n---\n\n${topic}`;
}

async function askOnce(query) {
  const hits = await searchHybrid(query, { topK: TOPK });
  const content = hits.length ? buildGroundedMessage(query, hits) : query;
  const t0 = Date.now();
  let answer = '', evalCount = 0, evalDurNs = 0;
  for await (const chunk of streamChat({
    model: MODEL,
    messages: [{ role: 'user', content }],
    tools: [],
    options: { temperature: 0, top_p: 0.9, num_ctx: NUM_CTX, think: false, num_predict: NUM_PRED > 0 ? NUM_PRED : -1 },
  })) {
    if (chunk.message?.content) answer += chunk.message.content;
    if (chunk.eval_count) evalCount = chunk.eval_count;
    if (chunk.eval_duration) evalDurNs = chunk.eval_duration;
  }
  const ms = Date.now() - t0;
  answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const toks = evalDurNs > 0 ? evalCount / (evalDurNs / 1e9) : 0;
  return { answer, ms, grounded: hits.length > 0, toks };
}

export async function runE2E({ limit } = {}) {
  const s = stats();
  console.log(`\n=== OH E2E 답변 평가 ===`);
  console.log(`모델=${MODEL}\nnum_ctx=${NUM_CTX} topK=${TOPK} · KB ${s.docs}문서\n`);
  let cases = loadDataset();
  if (limit) cases = cases.slice(0, limit);
  console.log(`케이스 ${cases.length}개 실행(각 1회, temp=0)…\n`);

  const rows = [];
  const kr = [], cov = [], lat = [], tps = [];
  for (const c of cases) {
    try {
      const r = await askOnce(c.query);
      const k = hangulRatio(r.answer);
      const cv = keywordCoverage(r.answer, c.expect_keywords);
      const deg = isDegenerate(r.answer);
      kr.push(k); cov.push(cv); lat.push(r.ms); if (r.toks) tps.push(r.toks);
      rows.push({ id: c.id, kr: pct(k), cov: pct(cv), ms: r.ms, tps: fmt(r.toks, 1),
        g: r.grounded ? '✓' : '—', len: r.answer.length, deg: deg ? '⚠폭주' : '' });
      process.stderr.write(`\r  ${c.id} 완료 (${r.ms}ms, ${fmt(r.toks, 0)}tok/s)            \n`);
    } catch (e) {
      rows.push({ id: c.id, kr: 'ERR', cov: e.message.slice(0, 20), ms: '-', tps: '-', g: '-', len: 0 });
    }
  }

  printTable(rows, [
    { key: 'id', label: 'id', w: 10 },
    { key: 'g', label: '근거', w: 4 },
    { key: 'kr', label: '한글', w: 7 },
    { key: 'cov', label: '핵심어', w: 7 },
    { key: 'ms', label: '지연ms', w: 8 },
    { key: 'tps', label: 'tok/s', w: 7 },
    { key: 'len', label: '길이', w: 7 },
    { key: 'deg', label: '퇴화', w: 6 },
  ]);
  console.log(`\n평균: 한글 ${pct(mean(kr))} · 핵심어 ${pct(mean(cov))} · 지연 ${fmt(mean(lat), 0)}ms · ${fmt(mean(tps), 1)}tok/s`);
  return rows;
}
