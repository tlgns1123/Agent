/**
 * OH — 공유 에이전트 턴 루프 (단일 진실원천)
 *
 * 배경(fix#2): 턴 루프가 프로덕션(index.js)과 평가(eval/*)에 각각 중복 구현돼
 * 평가가 프로덕션보다 덜 견고했다(빈응답 재시도·루프감지 부재 → 실제 능력 과소측정).
 * 이 모듈이 루프의 단일 구현이며, REPL과 eval 하니스가 **같은 코드**를 쓴다.
 *
 * 설계:
 *   - UI/상태 의존 없음. 순수하게 모델 호출 ↔ 툴 디스패치 루프만 담당.
 *   - 비동기 제너레이터로 이벤트를 흘려보낸다. 표시(색/필터)는 소비자(index.js UI,
 *     eval 수집기)가 담당 → 재사용 가능.
 *   - 대화 history(assistant/tool 메시지) push를 여기서 중앙관리 → 두 소비자 일관.
 *
 * 이벤트:
 *   { type:'content',     delta }              모델 원문 델타(소비자가 think/code 필터)
 *   { type:'stats',       stats }              스텝 종료 통계(eval_count 등)
 *   { type:'step',        content, hadToolCalls, iter }
 *   { type:'tool_start',  name, params }
 *   { type:'tool_result', name, params, result }
 *   { type:'notice',      code, message }      repetition|empty-retry|iterlimit|unsupported
 *   { type:'final',       content, reason, iterations }
 *
 * 반환값(제너레이터 return): { reason, iterations, content }
 */

import { streamChat } from './ollama.js';

// 부작용 없는 읽기 전용 툴 — 병렬 실행 안전(권한 프롬프트도 없음).
// write/run/delete/http 등 부작용 툴은 직렬 유지.
export const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'find_files', 'search_files',
  'rag_search', 'cve_lookup', 'attack_lookup', 'exploit_search',
  'gtfobins_lookup', 'lolbas_lookup', 'dependency_lookup',
  'web_search', 'web_fetch', 'web_research',
  'reverse_overview', 'reverse_strings', 'reverse_symbols', 'reverse_disasm',
  'todo_read',
]);

/** Ollama 툴 정의에서 OH 내부 메타(_mcp) 제거. */
export function toOllamaTool({ _mcp, ...clean }) { return clean; }

/**
 * 툴 인자 파싱. 로컬 모델이 가끔 깨진 JSON(홑따옴표/트레일링 콤마/비인용 키)을
 * 내보내므로 몇 단계 복구를 시도한다.
 */
export function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;

  try { return JSON.parse(raw); } catch { /* continue */ }

  const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
  }

  try {
    const fixed = raw
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  } catch { /* continue */ }

  return {};
}

/** 한 스텝의 서명 — 루프(동일 응답/동일 툴콜 반복) 감지용. */
function stepSignature(content, calls) {
  const c = (content || '').trim().slice(0, 200);
  const t = (calls || [])
    .map((tc) => {
      const fn = tc.function ?? tc;
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      return `${fn.name || ''}(${args})`;
    })
    .join('|');
  return `${c}##${t}`;
}

function isUnsupportedToolError(msg = '') {
  return /does not support tools|tool_calls|tool call/i.test(msg);
}

/**
 * 에이전트 턴을 실행하며 이벤트를 yield한다.
 *
 * @param {object}   o
 * @param {string}   o.model
 * @param {Array}    o.messages      대화 배열(assistant/tool 메시지가 여기 push됨 — in place 변경)
 * @param {Array}    [o.tools]       Ollama 툴 정의(이미 정제됨). 비면 순수 질의.
 * @param {object}   [o.options]     Ollama options(num_ctx/num_predict/temperature/think…)
 * @param {Function} [o.prepare]     () => requestMessages. 기본 = [system?, ...messages].
 * @param {string}   [o.systemPrompt]
 * @param {number}   [o.maxIter]
 * @param {AbortSignal} [o.signal]
 * @param {Function} o.dispatch      async (name, params) => result. 툴 실행(권한/스피너/스트리밍은 소비자 책임). result._denied면 중단.
 * @param {boolean}  [o.parallel]    읽기전용 툴 병렬 실행(기본 true)
 * @param {number}   [o.maxEmptyRetries]  빈응답 재시도 횟수(기본 1)
 * @param {Function} [o.verify]      async (content) => { pass:boolean, feedback:string } | null.
 *                                   최종 답변 직전 객관 검증(정적 게이트/실행). pass=false & feedback 있으면
 *                                   feedback을 되먹여 재생성(self-repair). 모델무관 지상검증이므로 self-critique와 다름.
 * @param {number}   [o.maxRepairs]  self-repair 최대 재생성 횟수(기본 0=off)
 */
export async function* runAgentTurn(o) {
  const {
    model, messages, tools = [], options = {},
    prepare, systemPrompt = null, maxIter = 10, signal, dispatch,
    parallel = true, maxEmptyRetries = 1, verify = null, maxRepairs = 0,
  } = o;

  const makeRequest = prepare
    ? prepare
    : () => (systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : [...messages]);

  const recent = [];        // 최근 스텝 서명(루프 감지)
  let emptyRetries = 0;
  let repairCount = 0;      // self-repair 재생성 횟수
  let curOptions = { ...options };

  for (let iter = 0; iter < maxIter; iter++) {
    const reqMessages = makeRequest();

    let fullContent = '';
    let nativeToolCalls = [];
    let finalStats = null;

    try {
      for await (const chunk of streamChat({ model, messages: reqMessages, tools, signal, options: curOptions })) {
        if (chunk.done) { finalStats = chunk; continue; }
        const msg = chunk.message;
        if (!msg) continue;
        if (msg.content) {
          fullContent += msg.content;
          yield { type: 'content', delta: msg.content };
        }
        if (msg.tool_calls?.length > 0) nativeToolCalls = msg.tool_calls;
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err;
      if (isUnsupportedToolError(err.message)) {
        yield { type: 'notice', code: 'unsupported', message: err.message };
        return { reason: 'unsupported', iterations: iter + 1, content: fullContent };
      }
      throw err;
    }

    if (finalStats) yield { type: 'stats', stats: finalStats };
    yield { type: 'step', content: fullContent, hadToolCalls: nativeToolCalls.length > 0, iter };

    // ── 루프 감지: 동일 응답/동일 툴콜이 최근 창에서 반복되면 중단 ──
    const sig = stepSignature(fullContent, nativeToolCalls);
    if (sig.replace(/##$/, '') && recent.includes(sig)) {
      yield { type: 'notice', code: 'repetition', message: '동일한 응답/툴호출이 반복되어 중단합니다.' };
      messages.push({ role: 'assistant', content: fullContent || '' });
      const r = { reason: 'repetition', iterations: iter + 1, content: fullContent };
      yield { type: 'final', ...r };
      return r;
    }
    recent.push(sig);
    if (recent.length > 3) recent.shift();

    // ── 네이티브 툴콜 처리 ──
    if (nativeToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: fullContent || null, tool_calls: nativeToolCalls });

      const parsed = nativeToolCalls.map((tc) => {
        const fn = tc.function ?? tc;
        return { name: fn.name, params: parseArgs(fn.arguments) };
      });

      // 읽기전용 툴 먼저 병렬 착수
      const results = new Array(parsed.length);
      const roStarted = new Set();
      if (parallel) {
        for (let i = 0; i < parsed.length; i++) {
          if (READ_ONLY_TOOLS.has(parsed[i].name)) {
            roStarted.add(i);
            yield { type: 'tool_start', name: parsed[i].name, params: parsed[i].params };
          }
        }
        await Promise.all([...roStarted].map(async (i) => {
          try { results[i] = await dispatch(parsed[i].name, parsed[i].params); }
          catch (e) { results[i] = { error: e.message }; }
        }));
      }

      // 원래 순서대로 결과 확정(부작용 툴은 여기서 직렬 실행) → tool 메시지 push
      let denied = false;
      for (let i = 0; i < parsed.length; i++) {
        const { name, params } = parsed[i];
        if (!roStarted.has(i)) {
          yield { type: 'tool_start', name, params };
          try { results[i] = await dispatch(name, params); }
          catch (e) { results[i] = { error: e.message }; }
        }
        yield { type: 'tool_result', name, params, result: results[i] };
        if (results[i]?._denied) { denied = true; break; }
        messages.push({ role: 'tool', content: JSON.stringify(results[i]) });
      }

      if (denied) {
        const r = { reason: 'denied', iterations: iter + 1, content: fullContent };
        yield { type: 'final', ...r };
        return r;
      }
      continue;
    }

    // ── 툴콜 없음 ──
    if (!fullContent.trim()) {
      // 빈 응답(사고 budget 소진 등) → think 끄고 1회 재시도
      if (emptyRetries < maxEmptyRetries) {
        emptyRetries++;
        curOptions = { ...curOptions, think: false };
        yield { type: 'notice', code: 'empty-retry', message: '빈 응답 — 사고를 멈추고 재시도합니다.' };
        messages.push({ role: 'assistant', content: '' });
        messages.push({ role: 'user', content: '방금 응답이 비어 있었다. 추가 사고 없이, 지금까지 확인한 내용으로 한국어 최종 답변 또는 다음 도구 호출을 즉시 수행하라.' });
        continue;
      }
      messages.push({ role: 'assistant', content: '' });
      const r = { reason: 'empty', iterations: iter + 1, content: '' };
      yield { type: 'final', ...r };
      return r;
    }

    // ── self-repair: 최종 답변 직전 객관 검증 → 실패 시 되먹여 재생성 ──
    if (verify && repairCount < maxRepairs) {
      let v = null;
      try { v = await verify(fullContent); }
      catch (e) { yield { type: 'notice', code: 'verify-error', message: e.message }; }
      if (v && v.pass === false && v.feedback) {
        repairCount++;
        yield { type: 'notice', code: 'code-repair', message: `정적/실행 검증 실패 — 재생성 ${repairCount}/${maxRepairs}` };
        messages.push({ role: 'assistant', content: fullContent });
        messages.push({ role: 'user', content: v.feedback });
        continue;
      }
    }

    messages.push({ role: 'assistant', content: fullContent });
    const r = { reason: 'plain', iterations: iter + 1, content: fullContent };
    yield { type: 'final', ...r };
    return r;
  }

  yield { type: 'notice', code: 'iterlimit', message: `툴 반복 상한(${maxIter}) 도달.` };
  const r = { reason: 'iterlimit', iterations: maxIter, content: '' };
  yield { type: 'final', ...r };
  return r;
}
