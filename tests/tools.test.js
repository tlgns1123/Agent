// OH 툴 단위 테스트 — read_file(라인범위/번호/잘림), edit_file(멀티/퍼지/에러),
// run_code(멀티라인 회귀/스트리밍), search_files(ripgrep|js), todo_write/read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../src/tools.js';

let dir, cwd0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'ohtest-')); cwd0 = process.cwd(); process.chdir(dir); });
after(() => { process.chdir(cwd0); rmSync(dir, { recursive: true, force: true }); });

test('read_file: offset/limit/메타/truncated', async () => {
  writeFileSync('big.txt', Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n'));
  const r = await executeTool('read_file', { path: 'big.txt', offset: 5, limit: 3 });
  assert.equal(r.content, 'line5\nline6\nline7');
  assert.equal(r.total_lines, 50);
  assert.equal(r.start_line, 5);
  assert.equal(r.end_line, 7);
  assert.equal(r.truncated, true);
});

test('read_file: line_numbers 포맷', async () => {
  writeFileSync('ln.txt', 'a\nb\nc');
  const r = await executeTool('read_file', { path: 'ln.txt', limit: 2, line_numbers: true });
  assert.match(r.content, /^\s+1\ta\n\s+2\tb$/);
});

test('read_file: 없는 파일 → error + hint', async () => {
  const r = await executeTool('read_file', { path: 'nope.txt' });
  assert.ok(r.error);
  assert.ok(r.hint);
});

test('edit_file: 단일 치환', async () => {
  writeFileSync('e.js', 'const a = 1;\nconst b = 2;\n');
  const r = await executeTool('edit_file', { path: 'e.js', old_string: 'const b = 2;', new_string: 'const b = 20;' });
  assert.ok(r.success);
});

test('edit_file: 멀티에딧(원자적) 2개', async () => {
  writeFileSync('m.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const r = await executeTool('edit_file', { path: 'm.js', edits: [
    { old_string: 'const a = 1;', new_string: 'const a = 11;' },
    { old_string: 'const c = 3;', new_string: 'const c = 33;' },
  ] });
  assert.ok(r.success);
  assert.equal(r.edits_applied, 2);
  const after = (await executeTool('read_file', { path: 'm.js' })).content;
  assert.ok(after.includes('a = 11') && after.includes('c = 33'));
});

test('edit_file: 공백 관대 매칭(들여쓰기 미세 불일치 흡수)', async () => {
  writeFileSync('f.py', 'def foo():\n        return 1\n');   // 8칸 들여쓰기
  const r = await executeTool('edit_file', { path: 'f.py', old_string: '    return 1', new_string: '    return 2' }); // 4칸으로 요청
  assert.ok(r.success);
  assert.ok((await executeTool('read_file', { path: 'f.py' })).content.includes('return 2'));
});

test('edit_file: 미발견 → error + hint', async () => {
  writeFileSync('g.js', 'x\n');
  const r = await executeTool('edit_file', { path: 'g.js', old_string: 'zzzz', new_string: 'y' });
  assert.ok(r.error);
  assert.ok(r.hint);
});

test('edit_file: 중복 매치 → 에러, replace_all 로 해결', async () => {
  writeFileSync('d.txt', 'x\nx\n');
  const r1 = await executeTool('edit_file', { path: 'd.txt', old_string: 'x', new_string: 'y' });
  assert.ok(r1.error);
  const r2 = await executeTool('edit_file', { path: 'd.txt', old_string: 'x', new_string: 'y', replace_all: true });
  assert.ok(r2.success);
});

test('run_code: 멀티라인 python 회귀(과거 cmd.exe 개행 버그)', async () => {
  const r = await executeTool('run_code', { language: 'python', code: 'a=1\nb=2\nprint(a+b)' });
  assert.ok(r.success, r.stderr);
  assert.equal(r.stdout.trim(), '3');
});

test('run_code: onOutput 스트리밍 콜백', async () => {
  let streamed = '';
  await executeTool('run_code', { language: 'python', code: 'print("hello-stream")' }, null, null, { onOutput: (s) => { streamed += s; } });
  assert.match(streamed, /hello-stream/);
});

test('search_files: 매치 반환(ripgrep 또는 js)', async () => {
  writeFileSync('s1.js', 'const token = "secret";\nfoo();\n');
  writeFileSync('s2.js', 'nothing\n');
  const r = await executeTool('search_files', { pattern: 'token', path: '.' });
  assert.ok(r.results.some((m) => m.file.includes('s1.js') && m.line === 1));
  assert.ok(['ripgrep', 'js'].includes(r.engine));
});

test('todo_write / todo_read', async () => {
  const w = await executeTool('todo_write', { todos: [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'pending' },
  ] });
  assert.ok(w.success);
  assert.deepEqual(w.summary, { total: 3, done: 1, doing: 1, pending: 1 });
  const r = await executeTool('todo_read', {});
  assert.equal(r.todos.length, 3);
});
