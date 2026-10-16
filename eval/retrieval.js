// OH Phase5 — 검색(RAG) 품질 평가. LLM 없이 결정적으로 돈다(빠름).
// topK/candidates/rerank 설정을 스윕해 "파라미터 상향이 실제로 재현율을 올리는지" 수치로 답한다.
import { searchHybrid, stats } from '../src/rag.js';
import { loadDataset, firstHitRank, mean, fmt, pct, printTable } from './lib.js';

// 평가할 설정들. 벡터+BM25(RRF) 리콜 스윕은 리랭커 없이 즉시 돈다(topK 상향 효과 측정).
// 마지막 한 줄만 리랭커 on(프로덕션 경로) — CPU 교차인코더라 느리므로 1설정만.
const CONFIGS = [
  { label: 'rrf  k3/c30',   topK: 3,  candidates: 30, rerank: false },
  { label: 'rrf  k5/c50',   topK: 5,  candidates: 50, rerank: false },
  { label: 'rrf  k6/c60',   topK: 6,  candidates: 60, rerank: false },
  { label: 'rrf  k10/c80',  topK: 10, candidates: 80, rerank: false },
  { label: 'RERANK k3/c30', topK: 3,  candidates: 30, rerank: true },
];

async function evalConfig(cases, cfg, { verbose } = {}) {
  const t0 = Date.now();
  const ranks = [], topScores = [];
  let zeroResults = 0, hits = 0;
  const perCase = [];
  for (const c of cases) {
    const results = await searchHybrid(c.query, { topK: cfg.topK, candidates: cfg.candidates, rerank: cfg.rerank });
    if (results.length === 0) zeroResults++;
    const rank = firstHitRank(results, c.expect_sources);
    if (rank > 0) hits++;
    ranks.push(rank);
    const top = results[0]?.rerank ?? results[0]?.score ?? 0;
    topScores.push(top);
    perCase.push({ id: c.id, rank: rank || '—', n: results.length, top: fmt(top, 2),
      got: (results[0]?.source || '—').split(':').pop()?.split('/').pop()?.slice(0, 32) || '—' });
    if (verbose && rank === 0) {
      console.log(`  [MISS ${c.id}] "${c.query.slice(0, 30)}" → ${results.slice(0, 3).map(r => r.source.split(':').pop()).join(' | ') || '(빈 결과)'}`);
    }
  }
  const mrr = mean(ranks.map(r => (r > 0 ? 1 / r : 0)));
  const hitAt1 = mean(ranks.map(r => (r === 1 ? 1 : 0)));
  return {
    label: cfg.label,
    recall: pct(hits / cases.length),
    hit1: pct(hitAt1),
    mrr: fmt(mrr),
    topScore: fmt(mean(topScores), 2),
    zero: zeroResults,
    ms: Date.now() - t0,
    perCase,
  };
}

export async function runRetrieval({ verbose = false } = {}) {
  const s = stats();
  console.log(`\n=== OH 검색 품질 평가 (KB ${s.docs}문서/${s.chunks}청크, embed=${s.model}) ===\n`);
  const cases = loadDataset();
  console.log(`테스트 케이스 ${cases.length}개\n`);

  const summary = [];
  for (const cfg of CONFIGS) {
    process.stderr.write(`  ▶ ${cfg.label} 실행 중…\n`);
    const r = await evalConfig(cases, cfg, { verbose });
    summary.push(r);
  }

  console.log('');
  printTable(summary, [
    { key: 'label', label: '설정', w: 16 },
    { key: 'recall', label: 'Recall', w: 8 },
    { key: 'hit1', label: 'Hit@1', w: 8 },
    { key: 'mrr', label: 'MRR', w: 7 },
    { key: 'topScore', label: '평균top점수', w: 11 },
    { key: 'zero', label: '빈결과', w: 6 },
    { key: 'ms', label: '소요ms', w: 7 },
  ]);

  if (verbose) {
    console.log(`\n--- 상세(${CONFIGS[0].label}) ---`);
    printTable(summary[0].perCase, [
      { key: 'id', label: 'id', w: 10 },
      { key: 'rank', label: 'rank', w: 5 },
      { key: 'n', label: 'n', w: 3 },
      { key: 'top', label: 'top', w: 6 },
      { key: 'got', label: '1위 소스', w: 34 },
    ]);
  }
  console.log('\nRecall=정답문서를 topK 안에 찾은 비율 · Hit@1=1위가 정답 · MRR=정답 순위 역수 평균');
  return summary;
}
