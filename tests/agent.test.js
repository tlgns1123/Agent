// OH 공유 에이전트 루프 테스트 — 가짜 Ollama 서버로 모델 없이 루프 로직을 검증.
// (fix#2로 프로덕션/eval이 공유하는 runAgentTurn의 핵심 동작을 보장.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setBaseUrl } from '../src/ollama.js';
import { runAgentTurn } from '../src/agent.js';

// ── 가짜 Ollama /api/chat 서버 ──────────────────────────────────────────────
// 요청마다 scriptQueue 에서 "응답 1개"(청크 배열)를 꺼내 NDJSON으로 흘려보낸다.
let scriptQueue = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const chunks = scriptQueue.shift() ?? [{ message: { role: 'assistant', content: '(script 없음)' } }, { done: true }];
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const c of chunks) res.write(JSON.stringify(c) + '\n');
    res.end();
  });
});

async function startServer() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  setBaseUrl(`http://127.0.0.1:${port}`);
}
function stopServer() { return new Promise((r) => server.close(r)); }

// 청크 빌더
const content  = (s) => ({ message: { role: 'assistant', content: s } });
const toolCall = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
const multiTool = (calls) => ({ message: { role: 'assistant', content: '', tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } });
const done = () => ({ done: true, eval_count: 5, eval_duration: 1_000_000 });

async function drain(gen) {
  const events = [];
  let ret;
  while (true) {
    const { value, done: d } = await gen.next();
    if (d) { ret = value; break; }
    events.push(value);
  }
  return { events, ret };
}

test('setup fake ollama', async () => { await startServer(); });

test('단일 툴콜 → 최종답변 (plain)', async () => {
  scriptQueue = [
    [toolCall('read_file', '{"path":"x.txt"}'), done()],
    [content('최종 답변입니다'), done()],
  ];
  const messages = [{ role: 'user', content: 'read x' }];
  const calls = [];
  const dispatch = async (name, params) => { calls.push({ name, params }); return { success: true, content: 'file body' }; };
  const { ret } = await drain(runAgentTurn({ model: 'fake', messages, tools: [{ type: 'function', function: { name: 'read_file' } }], dispatch, maxIter: 5 }));

  assert.equal(ret.reason, 'plain');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].params.path, 'x.txt');
  // history: user, assistant(tool_calls), tool, assistant(final)
  assert.equal(messages.at(-1).role, 'assistant');
  assert.match(messages.at(-1).content, /최종 답변/);
  assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
});

test('한 스텝 2개 툴콜 병렬 실행 + 순서 보존', async () => {
  scriptQueue = [
    [multiTool([{ name: 'read_file', args: '{"path":"a"}' }, { name: 'list_directory', args: '{"path":"."}' }]), done()],
    [content('둘 다 봤다'), done()],
  ];
  const messages = [{ role: 'user', content: 'go' }];
  const order = [];
  const dispatch = async (name) => { order.push(name); await new Promise((r) => setTimeout(r, name === 'read_file' ? 30 : 1)); return { ok: name }; };
  const { ret } = await drain(runAgentTurn({ model: 'fake', messages, tools: [{ type: 'function', function: { name: 'read_file' } }], dispatch, maxIter: 5 }));

  assert.equal(ret.reason, 'plain');
  // 둘 다 실행됐고, tool 메시지는 원래 순서(read_file 먼저)로 push
  assert.deepEqual([...order].sort(), ['list_directory', 'read_file']);
  const toolMsgs = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).ok);
  assert.deepEqual(toolMsgs, ['read_file', 'list_directory']);
});

test('동일 툴콜 반복 → 루프 감지로 중단', async () => {
  scriptQueue = [
    [toolCall('read_file', '{"path":"x"}'), done()],
    [toolCall('read_file', '{"path":"x"}'), done()],
    [toolCall('read_file', '{"path":"x"}'), done()],
    [toolCall('read_file', '{"path":"x"}'), done()],
    [toolCall('read_file', '{"path":"x"}'), done()],
  ];
  const messages = [{ role: 'user', content: 'go' }];
  let n = 0;
  const dispatch = async () => { n++; return { success: true }; };
  const { ret, events } = await drain(runAgentTurn({ model: 'fake', messages, tools: [{ type: 'function', function: { name: 'read_file' } }], dispatch, maxIter: 10 }));

  assert.equal(ret.reason, 'repetition');
  assert.ok(events.some((e) => e.type === 'notice' && e.code === 'repetition'));
  assert.ok(n <= 3, `반복은 3회 이내에 끊겨야 함(실제 ${n})`);
});

test('빈 응답 → think 끄고 1회 재시도', async () => {
  scriptQueue = [
    [done()],                               // 빈 응답, 툴콜 없음
    [content('재시도 후 답변'), done()],
  ];
  const messages = [{ role: 'user', content: 'go' }];
  const { ret, events } = await drain(runAgentTurn({ model: 'fake', messages, tools: [], dispatch: async () => ({}), maxIter: 5 }));

  assert.equal(ret.reason, 'plain');
  assert.match(ret.content, /재시도 후 답변/);
  assert.ok(events.some((e) => e.type === 'notice' && e.code === 'empty-retry'));
});

test('툴 거부 → denied 로 중단, 거부 결과는 history에 안 들어감', async () => {
  scriptQueue = [
    [toolCall('write_file', '{"path":"y","content":"z"}'), done()],
    [content('여기까지'), done()],   // 호출되면 안 됨
  ];
  const messages = [{ role: 'user', content: 'go' }];
  const dispatch = async () => ({ _denied: true, error: '거부됨' });
  const { ret } = await drain(runAgentTurn({ model: 'fake', messages, tools: [{ type: 'function', function: { name: 'write_file' } }], dispatch, maxIter: 5 }));

  assert.equal(ret.reason, 'denied');
  assert.equal(messages.filter((m) => m.role === 'tool').length, 0);
});

test('teardown', async () => { await stopServer(); });
