#!/usr/bin/env node
// OH Phase5 평가 하니스 진입점.
//   node eval/run.js retrieval [--verbose]   # 검색 품질(빠름, LLM 없음) — 기본
//   node eval/run.js e2e [N]                 # 종단간 답변(느림, 모델 실행). N=케이스 수 제한
import { runRetrieval } from './retrieval.js';
import { runE2E } from './e2e.js';
import { runCtf } from './ctf.js';

const [, , cmd = 'retrieval', ...rest] = process.argv;

try {
  if (cmd === 'retrieval') {
    await runRetrieval({ verbose: rest.includes('--verbose') || rest.includes('-v') });
  } else if (cmd === 'e2e') {
    const n = rest.map(Number).find(x => Number.isInteger(x) && x > 0);
    await runE2E({ limit: n });
  } else if (cmd === 'ctf') {
    await runCtf();
  } else {
    console.log('사용법: node eval/run.js [retrieval|e2e|ctf] [옵션]');
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error('평가 실패:', e.message);
  process.exit(1);
}
