/**
 * XML-based tool call parsing — fallback for models without native tool calling.
 *
 * Models are instructed to output:
 *   <tool_call>
 *   <name>tool_name</name>
 *   <parameters>{"key": "value"}</parameters>
 *   </tool_call>
 */

export function extractXmlToolCalls(text) {
  const calls = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    const nameMatcher = /<name>([\s\S]*?)<\/name>/s.exec(inner);
    const paramMatcher = /<parameters>([\s\S]*?)<\/parameters>/s.exec(inner);
    if (!nameMatcher) continue;

    const name = nameMatcher[1].trim();
    let params = {};
    if (paramMatcher) {
      const raw = paramMatcher[1].trim();
      try {
        params = JSON.parse(raw);
      } catch {
        // Attempt XML-tag params as fallback
        params = parseTagParams(raw);
      }
    }
    calls.push({ name, params });
  }
  return calls;
}

function parseTagParams(text) {
  const params = {};
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    params[m[1]] = m[2].trim();
  }
  return params;
}

export function stripXmlToolCalls(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

/**
 * Extract JSON-in-content tool calls — for models that output tool calls as
 * raw JSON objects in their text content instead of using native tool_calls.
 *
 * Handles both formats:
 *   {"name": "tool_name", "arguments": {...}}
 *   {"name": "tool_name", "parameters": {...}}
 *
 * Uses a balanced-bracket scanner so nested objects (e.g. write_file content
 * containing { }) and multi-line values are handled correctly.
 */
export function extractJsonToolCalls(text) {
  const calls = [];
  // Find every top-level '{' and extract the full balanced JSON object
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const obj = extractBalancedObject(text, i);
    if (!obj) continue;
    // Skip forward past this object to avoid re-matching inner braces
    i += obj.length - 1;
    // Quick pre-check before attempting JSON.parse
    if (!obj.includes('"name"')) continue;
    let parsed;
    try { parsed = JSON.parse(obj); } catch {
      // Models sometimes embed literal newlines inside JSON string values (invalid JSON).
      // Escape any unescaped newlines/tabs that appear inside string literals.
      try { parsed = JSON.parse(sanitizeJsonStrings(obj)); } catch { continue; }
    }
    const name = parsed.name;
    const params = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof name !== 'string' || typeof params !== 'object' || params === null) continue;
    calls.push({ name, params });
  }
  return calls;
}

/**
 * Replace unescaped literal newlines/carriage-returns/tabs inside JSON string
 * values with their escape sequences so JSON.parse can handle them.
 */
function sanitizeJsonStrings(text) {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n')      { result += '\\n';  continue; }
      if (ch === '\r')      { result += '\\r';  continue; }
      if (ch === '\t')      { result += '\\t';  continue; }
    }
    result += ch;
  }
  return result;
}

/**
 * Starting at index `start` (which must be '{'), walk forward tracking
 * bracket depth and string escapes, and return the full balanced substring.
 * Returns null if the object is not closed within `text`.
 */
function extractBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unclosed
}

/**
 * Build the XML tool-calling section to append to the system prompt.
 * Used when a model doesn't support native tool calling.
 */
export function buildXmlFallbackPrompt(toolDefs) {
  const list = toolDefs.map((t) => {
    const fn = t.function;
    const props = fn.parameters?.properties ?? {};
    const required = fn.parameters?.required ?? [];
    const paramLines = Object.entries(props)
      .map(([k, v]) => {
        const req = required.includes(k) ? ' [필수]' : ' [선택]';
        return `    - ${k} (${v.type})${req}: ${v.description ?? ''}`;
      })
      .join('\n');
    return `### ${fn.name}\n설명: ${fn.description ?? ''}\n파라미터:\n${paramLines || '    (없음)'}`;
  }).join('\n\n');

  return `\n\n## 툴 호출 방법 (XML 형식)

이 모델은 네이티브 함수 호출을 지원하지 않습니다. 툴을 사용할 때는 반드시 아래 XML 형식으로 호출하세요.

> ⚠️ **CRITICAL**: tool_call은 반드시 <think> 블록 **밖**에 출력할 것. <think> 내부에 쓰면 시스템이 인식하지 못합니다.

**규칙:**
- 툴 호출이 필요하면 반드시 XML을 출력하고 멈출 것. 결과를 상상하거나 직접 만들어내지 말 것.
- <tool_result>를 받은 후에만 다음 내용을 계속 작성할 것.
- 여러 툴을 순차적으로 호출할 수 있음 (각 호출 후 결과 대기).
- parameters 값은 반드시 유효한 JSON으로 작성할 것.
- 검색/조회 관련 질문은 지식 기반 답변 금지. 반드시 툴 먼저 호출할 것.

**호출 형식:**
\`\`\`
<tool_call>
<name>툴_이름</name>
<parameters>{"파라미터명": "값"}</parameters>
</tool_call>
\`\`\`

**사용 가능한 툴:**

${list}

**예시 — 웹 검색:**
<tool_call>
<name>web_research</name>
<parameters>{"topic": "검색할 내용", "max_sources": 3}</parameters>
</tool_call>`;
}
