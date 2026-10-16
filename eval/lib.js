// OH Phase5 평가 하니스 — 공용 유틸.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadDataset() {
  const raw = JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf8'));
  return raw.cases;
}

/** source 문자열이 기대 부분문자열 중 하나라도 포함하는가(대소문자 무시). */
export function sourceMatches(source, expectSources) {
  const s = (source || '').toLowerCase();
  return expectSources.some(e => s.includes(e.toLowerCase()));
}

/** 결과 배열에서 첫 정답의 1-based 순위. 없으면 0. */
export function firstHitRank(results, expectSources) {
  for (let i = 0; i < results.length; i++) {
    if (sourceMatches(results[i].source, expectSources)) return i + 1;
  }
  return 0;
}

/** 코드블록·인라인코드·URL을 제거해 "산문"만 남긴다(한글지표 아티팩트 방지). */
export function stripCode(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')        // 펜스 코드블록
    .replace(/`[^`]*`/g, ' ')               // 인라인 코드
    .replace(/https?:\/\/\S+/g, ' ')        // URL
    .replace(/[A-Za-z0-9_]+\([^)]*\)/g, ' '); // 함수호출 토큰
}

/** 산문(코드 제외)의 한글 비율(0~1). 공백 제외 "글자(letter)" 중 한글 음절 비율.
 *  숫자·기호는 분모에서 제외해 보안용어(영문 약어)만으로 과벌점되지 않게 한다. */
export function hangulRatio(text) {
  const prose = stripCode(text);
  const letters = (prose.match(/[\p{L}]/gu) || []);   // 유니코드 letter만
  if (!letters.length) return 0;
  const hangul = letters.filter(c => /[가-힣]/.test(c)).length;
  return hangul / letters.length;
}

/** 반복 폭주 감지: 같은 줄/구절이 과도 반복되면 true(퇴화 생성). */
export function isDegenerate(text, { maxLen = 20000 } = {}) {
  const t = text || '';
  if (t.length > maxLen) return true;
  const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 8);
  if (lines.length >= 10) {
    const uniq = new Set(lines).size;
    if (uniq / lines.length < 0.4) return true;   // 60%+ 중복 줄
  }
  return false;
}

/** 기대 키워드 중 답변에 포함된 비율(0~1). 대소문자 무시. */
export function keywordCoverage(answer, keywords) {
  if (!keywords?.length) return 1;
  const a = (answer || '').toLowerCase();
  const hit = keywords.filter(k => a.includes(k.toLowerCase())).length;
  return hit / keywords.length;
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function fmt(x, d = 3) { return Number(x).toFixed(d); }
export function pct(x) { return (x * 100).toFixed(1) + '%'; }

/** 간단 표 출력. rows=객체배열, cols=[{key,label,w}]. */
export function printTable(rows, cols) {
  const head = cols.map(c => String(c.label).padEnd(c.w)).join('  ');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log(cols.map(c => String(r[c.key] ?? '').padEnd(c.w)).join('  '));
  }
}
