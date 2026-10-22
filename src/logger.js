/**
 * OH — 턴 로깅 (JSONL)
 *
 * 에이전트 턴마다 한 줄씩 구조화 로그를 남긴다. 실패 디버깅 시 매번 진단
 * 스크립트를 새로 짤 필요 없이 이 파일만 보면 재현/추적이 된다.
 *
 * 기록 위치: <cwd>/.oh/turns.jsonl  (.gitignore 처리됨)
 * env:
 *   OH_LOG   on|off  (기본 on). off면 완전 비활성.
 *   OH_LOG_DIR  로그 디렉터리 override (기본 <cwd>/.oh)
 *
 * 비치명적: 쓰기 실패해도 에이전트 동작엔 영향 없음.
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

const ENABLED = (process.env.OH_LOG ?? 'on').toLowerCase() !== 'off';

export function loggingEnabled() { return ENABLED; }

function logDir() { return process.env.OH_LOG_DIR || join(process.cwd(), '.oh'); }
function logPath() { return join(logDir(), 'turns.jsonl'); }

let _dirReady = false;

/**
 * 한 레코드를 JSONL로 append. record는 자유 형식이지만 관례상:
 *   { kind, model, iter, prompt?, content?, tool_calls?, tool_results?, elapsed_ms?, stats?, reason? }
 * ts(ISO)는 자동 부여.
 */
export async function logTurn(record) {
  if (!ENABLED) return;
  try {
    if (!_dirReady) { await mkdir(logDir(), { recursive: true }); _dirReady = true; }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    await appendFile(logPath(), line, 'utf-8');
  } catch { /* 비치명적 */ }
}

/** 큰 문자열을 로그용으로 자른다(기본 2000자). */
export function clip(s, n = 2000) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  if (str == null) return str;
  return str.length > n ? str.slice(0, n) + `…[+${str.length - n}자]` : str;
}
