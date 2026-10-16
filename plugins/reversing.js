/**
 * OH 리버싱 플러그인 — 바이너리 정적 분석 (plugins/reversing.js)
 *
 * 설계 원칙:
 *  - RE 대상(바이너리)은 신뢰할 수 없다 → **항상 Kali WSL 샌드박스 안에서** 실행한다
 *    (OH_SANDBOX 모드와 무관하게 강제 격리). 호스트에서 절대 실행하지 않는다.
 *  - **정적 분석만** 수행한다. 대상 바이너리를 실제로 구동하지 않는다
 *    (file/strings/objdump/readelf/nm/radare2 -A 는 실행 없이 분석).
 *  - 도구 인자는 argv로 직접 전달(shell:false) → 셸 인젝션 불가.
 *  - 출력은 캡(기본 60KB)해 7B 컨텍스트를 보호한다.
 *
 * 전제: 대상 바이너리는 Kali 파일시스템 안 경로에 있어야 한다(automount 차단됨).
 *       예: wsl -d kali-linux -u root -- cp/scp 로 ~/sample 에 둔 뒤 그 경로 사용.
 *
 * 필요 도구: binutils(objdump/readelf/nm/strings), file, radare2. (미설치 시 안내 반환)
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { sandboxDistro, sandboxUser } from '../src/sandbox.js';

const IMPORT_DIR = '/root/oh-samples';

const MAX_OUT = Math.max(4096, parseInt(process.env.OH_RE_MAXOUT ?? '60000', 10) || 60000);
const TIMEOUT = Math.max(3000, parseInt(process.env.OH_RE_TIMEOUT ?? '30000', 10) || 30000);

/** wsl -d <distro> -u <user> -- <argv...> 를 실행. 대상 바이너리는 절대 실행하지 않음(정적 도구만). */
function wsl(argv, { timeout = TIMEOUT, maxOut = MAX_OUT } = {}) {
  return new Promise((resolve) => {
    const full = ['-d', sandboxDistro(), '-u', sandboxUser(), '--', ...argv];
    const p = spawn('wsl', full, { windowsHide: true });
    let out = '', err = '', capped = false, killed = false;
    const to = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (d) => {
      if (out.length < maxOut) out += d.toString();
      else if (!capped) { capped = true; p.kill('SIGKILL'); }
    });
    p.stderr.on('data', (d) => { if (err.length < 8000) err += d.toString(); });
    p.on('close', (code) => {
      clearTimeout(to);
      resolve({ code, out: out.slice(0, maxOut), err: err.trim(), capped, killed });
    });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: '', err: e.message, capped, killed }); });
  });
}

/** 호스트 파일(buf)을 샌드박스 안 dest로 stdin 파이프 전송(automount 없이 격리 유지). */
function wslWriteFile(buf, dest, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const full = ['-d', sandboxDistro(), '-u', sandboxUser(), '--', 'tee', dest];
    const p = spawn('wsl', full, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const to = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code, err: err.trim() }); });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, err: e.message }); });
    p.stdin.end(buf);
  });
}

/** 대상 경로가 샌드박스 안에 실제 파일로 존재하는지 확인. */
async function fileExists(path) {
  const r = await wsl(['test', '-f', path], { timeout: 8000 });
  return r.code === 0;
}

/** 특정 도구가 샌드박스에 설치돼 있는지. */
async function hasTool(tool) {
  const r = await wsl(['bash', '-lc', `command -v ${tool} >/dev/null 2>&1 && echo yes`], { timeout: 8000 });
  return r.out.includes('yes');
}

function errResult(msg) { return { error: msg }; }

async function guard(path, tool) {
  if (!path || typeof path !== 'string') return errResult('path(샌드박스 내 파일 경로)가 필요합니다.');
  if (!(await fileExists(path))) {
    return errResult(`샌드박스(${sandboxDistro()})에 파일이 없습니다: ${path}\n` +
      `대상 바이너리를 Kali 파일시스템(예: ~/sample)에 먼저 복사하세요. (/mnt/c 는 차단됨)`);
  }
  if (tool && !(await hasTool(tool))) {
    return errResult(`'${tool}' 미설치. 샌드박스에서 설치 필요: apt-get install -y binutils file radare2`);
  }
  return null;
}

export const name = 'reversing';
export const description = '바이너리 정적 리버싱 (Kali 샌드박스 격리, 실행 없이 분석)';

export const tools = [
  { type: 'function', function: {
    name: 'reverse_import',
    description: '호스트(Windows) 파일을 분석용으로 Kali 샌드박스에 자동 복사(/mnt/c 마운트 없이 격리 유지). 반환된 sandbox_path를 다른 reverse_* 툴에 사용. 리버싱 대상이 호스트에 있으면 가장 먼저 호출.',
    parameters: { type: 'object', properties: {
      host_path: { type: 'string', description: '호스트(Windows) 상 바이너리 경로' },
      name:      { type: 'string', description: '선택: 샌드박스 내 저장 파일명(기본 원본 파일명)' },
    }, required: ['host_path'] },
  }},
  { type: 'function', function: {
    name: 'reverse_overview',
    description: '바이너리 1차 트리아지: 파일 타입, 아키텍처, ELF/PE 헤더 요약, 스트립 여부, 섹션 목록. 리버싱 시작 시 가장 먼저 호출.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Kali 샌드박스 내 바이너리 절대/상대 경로' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'reverse_strings',
    description: '바이너리에서 출력 가능 문자열 추출(URL/키/명령/경로 단서 탐지). filter 주면 해당 부분문자열 포함 줄만 반환.',
    parameters: { type: 'object', properties: {
      path:   { type: 'string', description: 'Kali 샌드박스 내 경로' },
      min:    { type: 'integer', description: '최소 문자열 길이(기본 6)' },
      filter: { type: 'string', description: '선택: 이 부분문자열(대소문자 무시)을 포함한 줄만' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'reverse_disasm',
    description: '.text(또는 지정 섹션) 디스어셈블(objdump -d). 긴 출력은 max_lines로 제한.',
    parameters: { type: 'object', properties: {
      path:      { type: 'string', description: 'Kali 샌드박스 내 경로' },
      section:   { type: 'string', description: '선택: 섹션명(기본 전체 -d)' },
      max_lines: { type: 'integer', description: '반환 최대 줄 수(기본 400)' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'reverse_symbols',
    description: '심볼/임포트 목록(nm, readelf 동적심볼). 함수·라이브러리 의존 파악.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Kali 샌드박스 내 경로' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'reverse_r2',
    description: 'radare2 정적 분석 명령 실행(r2 -q -A -c <cmd>). 예 cmd: "afl"(함수목록), "ii"(임포트), "izz"(문자열), "pdf @ main"(main 디스어셈). 대상은 실행되지 않음.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Kali 샌드박스 내 경로' },
      cmd:  { type: 'string', description: 'radare2 명령(세미콜론으로 여러 개)' },
    }, required: ['path', 'cmd'] },
  }},
];

export async function execute(toolName, params = {}) {
  const path = params.path;

  if (toolName === 'reverse_import') {
    const host = params.host_path;
    if (!host || typeof host !== 'string') return errResult('host_path(호스트 파일 경로)가 필요합니다.');
    let buf;
    try { buf = await readFile(host); }
    catch (e) { return errResult(`호스트 파일 읽기 실패: ${e.message}`); }
    const safe = (params.name || basename(host)).replace(/[^\w.\-]/g, '_').slice(0, 128) || 'sample';
    const dest = `${IMPORT_DIR}/${safe}`;
    await wsl(['mkdir', '-p', IMPORT_DIR], { timeout: 8000 });
    const w = await wslWriteFile(buf, dest);
    if (w.code !== 0) return errResult(`샌드박스 복사 실패: ${w.err || 'exit ' + w.code}`);
    // 크기 검증
    const sz = await wsl(['bash', '-lc', `stat -c %s ${shq(dest)} 2>/dev/null`], { timeout: 8000 });
    const copied = parseInt((sz.out || '').trim(), 10);
    return { tool: 'reverse_import', sandbox_path: dest, host_path: host,
      host_bytes: buf.length, sandbox_bytes: Number.isFinite(copied) ? copied : null,
      ok: copied === buf.length,
      note: `복사 완료. 이후 reverse_* 툴에 path="${dest}" 사용.` };
  }

  if (toolName === 'reverse_overview') {
    const g = await guard(path, 'file'); if (g) return g;
    const file = await wsl(['file', path]);
    const hdr  = await wsl(['bash', '-lc', `readelf -hSd ${shq(path)} 2>/dev/null || objdump -f ${shq(path)} 2>/dev/null`]);
    return { tool: 'reverse_overview', path, distro: sandboxDistro(),
      file_type: file.out.trim(), header: hdr.out.trim() || hdr.err,
      note: '정적 분석 결과(실행되지 않음).' };
  }

  if (toolName === 'reverse_strings') {
    const g = await guard(path, 'strings'); if (g) return g;
    const min = Number.isInteger(params.min) ? params.min : 6;
    const r = await wsl(['strings', '-n', String(min), path]);
    let lines = r.out.split('\n');
    if (params.filter) {
      const f = String(params.filter).toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(f));
    }
    return { tool: 'reverse_strings', path, count: lines.length,
      strings: lines.slice(0, 500).join('\n'), capped: r.capped };
  }

  if (toolName === 'reverse_disasm') {
    const g = await guard(path, 'objdump'); if (g) return g;
    const maxLines = Number.isInteger(params.max_lines) ? params.max_lines : 400;
    const args = params.section ? ['objdump', '-d', '-j', params.section, path] : ['objdump', '-d', path];
    const r = await wsl(args);
    const lines = r.out.split('\n').slice(0, maxLines);
    return { tool: 'reverse_disasm', path, section: params.section ?? '(all)',
      disasm: lines.join('\n'), truncated: r.out.split('\n').length > maxLines || r.capped };
  }

  if (toolName === 'reverse_symbols') {
    const g = await guard(path, 'nm'); if (g) return g;
    const nm   = await wsl(['bash', '-lc', `nm -C ${shq(path)} 2>/dev/null | head -300`]);
    const dyn  = await wsl(['bash', '-lc', `readelf --dyn-syms -W ${shq(path)} 2>/dev/null | head -200`]);
    return { tool: 'reverse_symbols', path,
      symbols: nm.out.trim() || '(정적 심볼 없음/스트립됨)',
      dynamic: dyn.out.trim() || '(동적 심볼 없음)' };
  }

  if (toolName === 'reverse_r2') {
    const g = await guard(path, 'radare2'); if (g) return g;
    if (!params.cmd) return errResult('cmd(radare2 명령)가 필요합니다.');
    // r2 -q -A -c <cmd> <path> : 정적 분석. 대상 바이너리는 실행되지 않음.
    const r = await wsl(['r2', '-q', '-e', 'scr.color=0', '-A', '-c', params.cmd, path], { timeout: Math.max(TIMEOUT, 45000) });
    return { tool: 'reverse_r2', path, cmd: params.cmd,
      output: (r.out.trim() || r.err || '(출력 없음)').slice(0, MAX_OUT), capped: r.capped };
  }

  return errResult(`알 수 없는 툴: ${toolName}`);
}

/** POSIX 작은따옴표 이스케이프(bash -lc 로 넘기는 경로용). */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
