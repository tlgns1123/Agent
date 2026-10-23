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
 * 본문에 텍스트로 섞여 나온 툴 호출을 복구한다. 일부 모델(예: Qwen3-Coder)이
 * 네이티브 tool_calls 대신 <tool_call>{...}</tool_call> 또는 ```json {"name","arguments"}```
 * 또는 벌거벗은 JSON으로 호출을 "서술"해 버리는 경우 — 안 잡으면 "설명만 하고 실행 안 함"이 된다.
 * 반환: 네이티브와 동일 형태 [{ function: { name, arguments } }] (유효 툴명만).
 */
export function extractTextToolCalls(content, tools) {
  const valid = new Set((tools || []).map((t) => t.function?.name || t.name).filter(Boolean));
  if (!valid.size || !content) return [];
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    let obj; try { obj = JSON.parse(raw); } catch { return; }
    for (const c of (Array.isArray(obj) ? obj : [obj])) {
      if (c && typeof c === 'object' && typeof c.name === 'string' && valid.has(c.name)) {
        const args = c.arguments ?? c.parameters ?? {};
        const key = c.name + JSON.stringify(args);
        if (!seen.has(key)) { seen.add(key); out.push({ function: { name: c.name, arguments: args } }); }
      }
    }
  };
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) add(m[1].trim());
  for (const m of content.matchAll(/```(?:json|tool_code)?\s*([\s\S]*?)```/g)) {
    const b = m[1].trim();
    if (/"name"\s*:/.test(b)) add(b);
  }
  if (!out.length) {                        // 펜스/태그 없는 바로 {"name":...,"arguments":...}
    for (let i = 0; i < content.length; i++) {
      if (content[i] !== '{') continue;
      let depth = 0;
      for (let j = i; j < content.length; j++) {
        if (content[j] === '{') depth++;
        else if (content[j] === '}') {
          if (--depth === 0) { const blk = content.slice(i, j + 1); if (/"name"\s*:/.test(blk)) add(blk); i = j; break; }
        }
      }
    }
  }
  return out;
}

/** 복구된 툴콜 텍스트를 본문에서 제거(모델이 쓴 서술 JSON이 히스토리에 남지 않도록). */
function stripToolCallText(content) {
  return (content || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/```(?:json|tool_code)?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*```/g, '')
    .trim();
}

/**
 * "방법만 설명/계획하고 도구를 안 쓴" 응답인지 — 넛지(1회 재시도) 판단용.
 * 순수 개념 답변("X란 …입니다")에는 걸리지 않도록 미래형 약속·안내문·결과없는 코드블록만 잡는다.
 */
function looksDeferred(content) {
  const t = content || '';
  if (/(하겠습니다|해보겠습니다|확인하겠|실행하겠|분석하겠|진행하겠|시도하겠|찾아보겠|살펴보겠|확인해\s?보겠|복호화하겠|디코드하겠)/.test(t)) return true;
  if (/(다음\s*(명령|코드|스크립트)|아래\s*(명령|코드|스크립트)|실행하면|실행해\s*보면|하면\s*됩니다|사용하면\s*됩니다|하시면\s*됩니다)/.test(t)) return true;
  if (/```/.test(t) && !/(결과|출력|FLAG\{|확인했|실행했|실행\s*결과|복호화한\s*결과|returned|output)/i.test(t)) return true;
  return false;
}

/**
 * 도구로만 알 수 있는 결과(파일 내용·실행 출력·플래그·비밀번호 등)를 도구 없이 "단정"하는지.
 * 넛지 조건과 함께(도구 0회일 때만) 쓰여 "날조" 모드를 잡는다. 날조 방지이지 일반 답변 억제가 아님.
 */
function claimsUnverifiedResult(content) {
  return /(FLAG\{|플래그\s*(는|:|=)|플래그를\s*(찾|획득)|정답\s*(은|:)|비밀번호\s*(는|:)|출력\s*(값)?\s*은|실행\s*결과\s*는|the flag is)/i.test(content || '');
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
    maxToolNudges = Number(process.env.OH_TOOL_NUDGE ?? 1),
  } = o;

  const makeRequest = prepare
    ? prepare
    : () => (systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : [...messages]);

  const recent = [];        // 최근 스텝 서명(루프 감지)
  let emptyRetries = 0;
  let repairCount = 0;      // self-repair 재생성 횟수
  let nudgeCount = 0;       // 툴 넛지(모드 B) 횟수
  let anyToolUsed = false;  // 이 턴에서 도구를 한 번이라도 썼는가
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

    // ── 텍스트로 표현된 툴콜 복구 (네이티브 미방출 시 — 포맷 드리프트 방어) ──
    if (nativeToolCalls.length === 0 && fullContent) {
      const recovered = extractTextToolCalls(fullContent, tools);
      if (recovered.length) {
        nativeToolCalls = recovered;
        fullContent = stripToolCallText(fullContent);
        yield { type: 'notice', code: 'text-toolcall', message: `텍스트로 표현된 툴 호출 ${recovered.length}건을 복구해 실행합니다.` };
      }
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
      anyToolUsed = true;
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

    // ── 넛지-재시도(모드 B): 도구를 전혀 안 쓰고 "설명/계획"하거나 결과를 "날조"하면 1회 밀어준다 ──
    if (tools.length > 0 && !anyToolUsed && nudgeCount < maxToolNudges
        && (looksDeferred(fullContent) || claimsUnverifiedResult(fullContent))) {
      nudgeCount++;
      yield { type: 'notice', code: 'tool-nudge', message: '도구 없이 설명만 하여 실제 수행을 1회 재촉합니다.' };
      messages.push({ role: 'assistant', content: fullContent });
      messages.push({ role: 'user', content: '방금 답변은 방법을 설명·계획만 하고 도구를 실제로 호출하지 않았다. 이 작업은 실제 수행이 필요하다 — 지금 적절한 도구(run_command/run_code/read_file/stage_to_sandbox 등)를 호출해 직접 실행하고 그 결과로 답하라. 정말로 도구가 불필요한 질문이었다면 그 이유와 함께 그대로 최종 답을 주면 된다.' });
      continue;
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
