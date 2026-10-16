/**
 * OH — 자기검증 2차 패스 (Phase 3, 검증 레이어)
 *
 * 근거(RAG/웹/CVE/ATT&CK)가 주입된 턴에서, 모델이 내놓은 최종 답변의
 * 각 사실 주장이 그 근거로 실제 뒷받침되는지 2차 패스로 점검한다.
 * - 근거가 없었던 턴(잡담·코딩)은 검증하지 않는다 → 비용 0.
 * - flag 모드(기본): 미근거(환각) 주장을 찾아 경고로 표시.
 * - correct 모드: 미근거 주장이 있으면 근거만으로 답변을 재작성.
 *
 * env:
 *   OH_VERIFY        on/off  (기본 on)
 *   OH_VERIFY_MODE   flag|correct  (기본 flag)
 *   OH_VERIFY_MIN    검증을 돌릴 최소 답변 길이 (기본 60자)
 */

import chalk from 'chalk';
import { streamChat } from './ollama.js';

export function verifyEnabled() {
  return (process.env.OH_VERIFY ?? 'on').toLowerCase() !== 'off';
}
export function verifyMode() {
  return (process.env.OH_VERIFY_MODE ?? 'flag').toLowerCase() === 'correct' ? 'correct' : 'flag';
}
function verifyMin() {
  const n = parseInt(process.env.OH_VERIFY_MIN ?? '60', 10);
  return Number.isFinite(n) ? n : 60;
}

/**
 * 검증관 모델의 원문 출력을 파싱한다(순수 함수, 테스트 가능).
 * 반환: { verdict:'ok'|'issues', issues:{severity,text}[] }
 *   severity: 'contradiction'(근거와 모순, 심각) | 'unsupported'(근거에 없음, 경미)
 * 관용 규칙: bullet 또는 "문제있음" 있으면 issues. 둘 다 모호하면 거짓경보 방지로 ok.
 */
export function parseVerdict(raw) {
  const text = (raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const saysProblem = /판정:\s*문제|문제\s*있음/i.test(text);

  const bullets = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*•]\s+/.test(l))
    .map(l => l.replace(/^[-*•]\s+/, '').trim())
    .filter(Boolean);

  const issues = [];
  for (const line of bullets) {
    const m = line.match(/^\[?\s*(모순|contradiction|미근거|unsupported|근거없음|일치|match|뒷받침)\s*\]?\s*[:：]?\s*(.*)$/i);
    const tag  = m?.[1]?.toLowerCase();
    const body = ((m ? m[2] : line).trim()) || line;

    // [일치]/match → 문제 아님(스킵). 분류 프레이밍에서 일치 항목도 출력됨.
    if (tag === '일치' || tag === 'match' || tag === '뒷받침') continue;

    if (tag === '모순' || tag === 'contradiction') { issues.push({ severity: 'contradiction', text: body }); continue; }
    if (tag === '미근거' || tag === 'unsupported' || tag === '근거없음') { issues.push({ severity: 'unsupported', text: body }); continue; }

    // 태그 없는 bullet: "문제있음" 판정이 있을 때만 미근거로 간주(구버전 포맷 호환)
    if (saysProblem) issues.push({ severity: 'unsupported', text: body });
  }

  // 중복 제거(텍스트 기준) + 모순 우선 정렬
  const seen = new Set();
  const deduped = issues.filter(i => {
    const k = i.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => (a.severity === 'contradiction' ? 0 : 1) - (b.severity === 'contradiction' ? 0 : 1));

  if (deduped.length > 0) return { verdict: 'issues', issues: deduped.slice(0, 8) };
  return { verdict: 'ok', issues: [] };   // 일치만 있거나 모호 → 거짓경보 방지
}

/** streamChat을 모아 하나의 완성 텍스트로 반환(비스트리밍). think 블록 제거. */
async function complete({ model, messages, options, signal }) {
  let out = '';
  for await (const chunk of streamChat({ model, messages, tools: [], options, signal })) {
    if (chunk.message?.content) out += chunk.message.content;
  }
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** 답변에서 표시·내부 마커를 떼고 검증 대상 순수 텍스트만 남긴다. */
function cleanAnswer(answer) {
  return (answer ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim();
}

/**
 * 자기검증 실행. 근거 주입이 없었으면 null 반환(검증 스킵).
 * 반환: { verdict:'ok'|'issues'|'skip', issues:string[], corrected?:string }
 */
export async function verifyAnswer(state, { answer, signal } = {}) {
  if (!verifyEnabled()) return null;

  const grounding = state._lastGrounding;
  if (!grounding?.context) return null;       // 근거 없는 턴 → 검증 안 함

  const clean = cleanAnswer(answer);
  if (clean.length < verifyMin()) return null; // 너무 짧은 답 → 스킵

  // 모델이 이미 "근거에 없음"이라고 정직하게 답했으면 통과 처리
  if (/(지식베이스에 없음|검색 결과에 없음|공식 ?DB에 없음|확인(되지|할 수) ?(않|없))/.test(clean)) {
    return { verdict: 'ok', issues: [] };
  }

  const sources = grounding.context.slice(0, 9000);
  const verifyPrompt =
    `당신은 신중한 사실검증관이다. [답변]에서 "검증 가능한 구체적 사실 주장"(수치·날짜·이름·버전·제품·인과)을 ` +
    `최대 8개 뽑아, 각각을 [근거]와 대조해 한 줄씩 분류하라.\n\n` +
    `분류 태그:\n` +
    `- [일치] 답변의 사실이 근거로 뒷받침됨. 표현이 달라도 값/의미가 같으면 일치다 (예: "CVSS 10.0" = "심각도 10.0 CRITICAL").\n` +
    `- [모순] 답변의 사실이 근거와 실제로 다름. 수치·날짜·버전·이름은 정확히 비교하라 (예: 근거 97.4%인데 답변 87% → 모순, 근거 10.0인데 답변 7.5 → 모순, 근거 Log4j2인데 답변 Struts → 모순). 근사·반올림으로 봐주지 마라.\n` +
    `- [미근거] 답변이 구체적 사실을 주장하나 근거에 그 내용이 전혀 없음.\n\n` +
    `중요 지침:\n` +
    `- 답변에 실제로 나온 사실만 추출하라. 근거에만 있고 답변엔 없는 내용은 무시한다(누락은 문제 아님).\n` +
    `- 의견·조언·권고·일반 보안설명·요약은 추출하지 마라. 오직 구체적 사실 주장만.\n` +
    `- 값/의미가 같으면 표현이 달라도 [일치]. 그러나 수치·날짜·버전이 실제로 다르면 반드시 [모순].\n\n` +
    `출력(한 줄에 하나, 정확히 이 형식. 일치 항목도 빠짐없이 출력하라):\n` +
    `- [일치] <사실 주제>\n` +
    `- [모순] <사실 주제>: 답변=<답변의 값>, 근거=<근거의 값>\n` +
    `- [미근거] <답변의 주장>\n\n` +
    `[근거]\n${sources}\n\n[답변]\n${clean}`;

  let raw;
  try {
    raw = await complete({
      model: state.model,
      messages: [{ role: 'user', content: verifyPrompt }],
      options: { temperature: 0, top_p: 0.9, num_ctx: state.contextLength ?? 8192, think: false, num_predict: 512 },
      signal,
    });
  } catch {
    return null; // 검증 실패는 비치명적
  }

  const parsed = parseVerdict(raw);
  if (parsed.verdict === 'ok') return parsed;

  const result = { verdict: 'issues', issues: parsed.issues };

  if (verifyMode() === 'correct') {
    result.corrected = await rewriteFromSources(state, { answer: clean, sources, signal }).catch(() => null);
  }

  return result;
}

/** correct 모드: 근거만으로 답변을 재작성(미근거 주장 제거). */
async function rewriteFromSources(state, { answer, sources, signal }) {
  const prompt =
    `아래 [근거]만 사용해 [기존답변]을 다시 써라. 근거로 뒷받침되지 않는 주장은 모두 빼고, ` +
    `근거에 없어 확인 불가한 부분은 "근거에서 확인되지 않음"이라고 명시하라. ` +
    `반드시 한국어로, 출처(문서명›섹션)를 함께 밝혀라.\n\n` +
    `[근거]\n${sources}\n\n[기존답변]\n${answer}`;
  const out = await complete({
    model: state.model,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.2, top_p: 0.9, num_ctx: state.contextLength ?? 8192, think: false },
    signal,
  });
  return out || null;
}

/** 검증 결과를 콘솔에 출력하고, correct 모드의 재작성 답변을 state에 반영. */
export function presentVerification(state, result) {
  if (!result || result.verdict === 'skip') return;

  if (result.verdict === 'ok') {
    console.log(chalk.dim(`\n  ✓ 자기검증: 답변이 주입된 근거와 일치 (출처: ${state._lastGrounding?.kind ?? 'KB'})`));
    return;
  }

  // issues — 심각도 구분: 모순(빨강, 심각) > 미근거(노랑, 경미)
  const issues = result.issues.map(it => typeof it === 'string' ? { severity: 'unsupported', text: it } : it);
  const contra = issues.filter(i => i.severity === 'contradiction');
  const unsup  = issues.filter(i => i.severity !== 'contradiction');
  const head = contra.length > 0
    ? chalk.red(`\n  ⚠ 자기검증: 근거와 모순 ${contra.length}건` + (unsup.length ? `, 미근거 ${unsup.length}건` : ''))
    : chalk.yellow(`\n  ⚠ 자기검증: 근거로 뒷받침되지 않는 주장 ${unsup.length}건`);
  console.log(head);
  for (const i of contra) console.log(chalk.red(`    ✗ [모순] ${i.text}`));
  for (const i of unsup)  console.log(chalk.yellow(`    • [미근거] ${i.text}`));

  if (result.corrected) {
    console.log(chalk.cyan(`\n  🔁 근거 기반으로 재작성한 답변:`));
    console.log('\n' + result.corrected.split('\n').map(l => '  ' + l).join('\n') + '\n');
    // 대화 이력의 마지막 assistant 답변을 교정본으로 교체 → 다음 턴 일관성 유지
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant') {
        state.messages[i].content = result.corrected;
        break;
      }
    }
  } else {
    console.log(chalk.dim(`    (OH_VERIFY_MODE=correct 로 설정하면 근거 기반 재작성까지 수행합니다)`));
  }
}
