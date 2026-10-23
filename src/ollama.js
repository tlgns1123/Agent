import { spawn } from 'child_process';

let BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

export function setBaseUrl(url) {
  BASE_URL = url;
}

export function getBaseUrl() {
  return BASE_URL;
}

export async function listModels() {
  const res = await fetch(`${BASE_URL}/api/tags`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.models || [];
}

export async function deleteModel(name) {
  const res = await fetch(`${BASE_URL}/api/delete`, {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: name }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Pull (download/update) a model. Yields progress objects:
 *   { status, digest?, total?, completed?, percent? }
 * signal: AbortController.signal to cancel.
 */
export async function* pullModel(name, signal) {
  const res = await fetch(`${BASE_URL}/api/pull`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: name, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama pull ${res.status}: ${text}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed);
        if (chunk.total && chunk.completed) {
          chunk.percent = Math.round((chunk.completed / chunk.total) * 100);
        }
        yield chunk;
      } catch { /* skip */ }
    }
  }
}

/**
 * Embed one or more texts via Ollama /api/embed.
 * input: string or string[]. Returns number[][] (one vector per input).
 */
export async function embed({ model, input, signal } = {}) {
  const inputs = Array.isArray(input) ? input : [input];
  const res = await fetch(`${BASE_URL}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, input: inputs }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.embeddings?.length) throw new Error('Ollama embed: 빈 응답 (모델이 임베딩 미지원일 수 있음)');
  return data.embeddings;
}

export async function ping() {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// BASE_URL이 로컬(localhost/127.0.0.1)을 가리키는지 — 원격 호스트면 자동 기동 의미 없음.
function isLocalHost() {
  try { return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(new URL(BASE_URL).hostname); }
  catch { return false; }
}

/**
 * Ollama 가용성 보장. 미기동이면(로컬일 때만) `ollama serve`를 분리 프로세스로 띄우고
 * 응답할 때까지 폴링한다. OH 종료와 무관하게 서버는 남는다(unref).
 * 반환: { ok, started, error? }
 *   OH_AUTOSTART=off 면 자동 기동 안 함(기존처럼 ping만).
 */
export async function ensureOllama({ timeoutMs = 25000 } = {}) {
  if (await ping()) return { ok: true, started: false };
  if ((process.env.OH_AUTOSTART ?? 'on').toLowerCase() === 'off') return { ok: false, started: false };
  if (!isLocalHost()) return { ok: false, started: false, error: 'remote-host' };

  try {
    const bin = process.env.OLLAMA_BIN || 'ollama';
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, shell: true });
    child.on('error', () => {});   // 바이너리 없음 등은 아래 폴링 타임아웃으로 귀결
    child.unref();
  } catch (e) {
    return { ok: false, started: false, error: e.message };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 600));
    if (await ping()) return { ok: true, started: true };
  }
  return { ok: false, started: true, error: 'timeout' };
}

/**
 * Stream chat with Ollama. Yields parsed JSON chunks.
 * Each chunk: { message: { role, content, tool_calls? }, done }
 * Pass signal: AbortController.signal to cancel mid-stream.
 * Auto-retries on connection failure (up to MAX_RETRIES times).
 */
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000;

export async function* streamChat({ model, messages, tools = [], signal, options, idleTimeout } = {}) {
  const body = { model, messages, stream: true };
  if (tools.length > 0) body.tools = tools;
  if (options && Object.keys(options).length > 0) body.options = options;

  let res;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      break; // success
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === MAX_RETRIES) throw new Error(`Ollama 연결 실패 (${MAX_RETRIES}회 재시도): ${err.message}`);
      const wait = RETRY_DELAY_MS * (attempt + 1);
      process.stderr.write(`\r  Ollama 연결 끊김 — ${wait / 1000}초 후 재시도 (${attempt + 1}/${MAX_RETRIES})…`);
      await new Promise(r => setTimeout(r, wait));
      process.stderr.write('\r' + ' '.repeat(60) + '\r');
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Watchdog: if no data arrives, abort the stream.
  // Default 5 minutes — local models (e.g. 32B) can be slow on complex prompts.
  // Use a single long-lived timer that checks elapsed time since last chunk
  // to avoid the overhead of clearTimeout/setTimeout on every chunk.
  const IDLE_TIMEOUT_MS = idleTimeout ?? 300_000;
  let lastChunkAt = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastChunkAt >= IDLE_TIMEOUT_MS) reader.cancel('idle timeout');
  }, Math.min(IDLE_TIMEOUT_MS, 10_000));
  const resetIdle = () => { lastChunkAt = Date.now(); };

  // Race reader.read() against the abort signal so Ctrl+C cancels immediately
  // even while awaiting the next chunk from a slow model.
  const readChunk = () => {
    if (!signal) return reader.read();
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reader.cancel('aborted').catch(() => {});
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  };

  try {
  while (true) {
    let done, value;
    try {
      ({ done, value } = await readChunk());
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      break;
    }
    if (done) break;
    resetIdle();

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed);
        yield chunk;
        if (chunk.done) return;
      } catch { /* skip malformed */ }
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim());
      yield chunk;
    } catch { /* skip */ }
  }
  } finally {
    clearInterval(idleTimer);
  }
}
