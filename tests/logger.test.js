// OH 턴 로깅 테스트 — JSONL 기록/클립/비활성 동작.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logTurn, clip, loggingEnabled } from '../src/logger.js';

let dir, cwd0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'ohlog-')); cwd0 = process.cwd(); process.chdir(dir); });
after(() => { process.chdir(cwd0); rmSync(dir, { recursive: true, force: true }); });

test('clip: 긴 문자열 자르고 표시', () => {
  assert.equal(clip('abc', 10), 'abc');
  const long = 'x'.repeat(100);
  const c = clip(long, 10);
  assert.ok(c.startsWith('xxxxxxxxxx'));
  assert.match(c, /\[\+90자\]$/);
});

test('logTurn: .oh/turns.jsonl 에 한 줄 기록', async (t) => {
  if (!loggingEnabled()) return t.skip('OH_LOG=off');
  await logTurn({ kind: 'turn', model: 'fake', prompt: 'hi', reason: 'plain', iterations: 1 });
  await logTurn({ kind: 'turn', model: 'fake', prompt: 'bye', reason: 'plain', iterations: 2 });
  const p = join(dir, '.oh', 'turns.jsonl');
  assert.ok(existsSync(p), 'turns.jsonl 생성');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.model, 'fake');
  assert.equal(rec.reason, 'plain');
  assert.ok(rec.ts, 'ts 자동 부여');
});
