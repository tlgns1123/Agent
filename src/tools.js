import {
  readFile, writeFile, unlink, rename, copyFile,
  mkdir, rm, readdir, stat,
} from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, dirname, join, relative, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { wrapShellCommand, wrapCode, sandboxLabel } from './sandbox.js';

// ─── Sandbox ──────────────────────────────────────────────────────────────────
// Sandbox: write/delete/edit/move ops are restricted to inside cwd.
// Read ops (read_file, list_directory, find_files, search_files) are unrestricted.
// cwd is checked dynamically so /cd changes are respected.

function isInsideProject(absPath) {
  const root = resolve(process.cwd());
  const rel  = relative(root, absPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Returns an error object if the path is outside the project, otherwise null. */
function sandboxCheck(absPath, label = 'Path') {
  if (!isInsideProject(absPath)) {
    return {
      error: `${label} is outside the project folder — only read operations are allowed there.\n` +
             `  Requested : ${absPath}\n` +
             `  Project   : ${resolve(process.cwd())}`,
    };
  }
  return null;
}

// ─── Tool Definitions (OpenAI / Ollama format) ─────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or create a file with the given content. Creates parent directories automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file or directory',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file to a new location',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path' },
          destination: { type: 'string', description: 'Destination file path' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and any missing parent directories)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_directory',
      description: 'Delete an empty directory. Use recursive:true to delete a directory and all its contents.',
      parameters: {
        type: 'object',
        properties: {
          path:      { type: 'string',  description: 'Directory path to delete' },
          recursive: { type: 'boolean', description: 'Delete contents recursively (default: false)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make a targeted edit to a file by replacing an exact string. If old_string is empty, overwrites the entire file with new_string (use to clear or replace whole content).',
      parameters: {
        type: 'object',
        properties: {
          path:        { type: 'string',  description: 'File path to edit' },
          old_string:  { type: 'string',  description: 'Exact text to find and replace (must be unique in the file)' },
          new_string:  { type: 'string',  description: 'Text to replace it with' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness (default: false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by name pattern (glob-style) in a directory tree. Use this to locate files before reading or editing them.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename pattern — supports * and ? wildcards, e.g. "*.js", "test_*.py", "README*"' },
          path:    { type: 'string', description: 'Directory to search in (default: current dir)' },
          type:    { type: 'string', enum: ['file', 'dir', 'any'], description: 'Match files, dirs, or both (default: any)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories. Use depth > 1 to see nested contents.',
      parameters: {
        type: 'object',
        properties: {
          path:  { type: 'string',  description: 'Directory path (default: current working directory)' },
          depth: { type: 'integer', description: 'How many levels deep to list (default: 1, max: 5)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'Execute code in Python, Node.js, or Shell and return stdout/stderr',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'node', 'shell'],
            description: 'Language to execute',
          },
          code: { type: 'string', description: 'Code to run' },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a terminal / shell command and return its output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd:     { type: 'string',  description: 'Working directory (optional)' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds (default: 30000). Use higher values for long-running tasks like builds or installs.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern (regex) across files in a directory. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern:          { type: 'string',  description: 'Search pattern (regex or plain text)' },
          path:             { type: 'string',  description: 'Directory or file to search in (default: current dir)' },
          glob:             { type: 'string',  description: 'File extension filter e.g. "*.js" or "*.py"' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          max_results:      { type: 'integer', description: 'Max matching lines to return (default: 50)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_research',
      description: 'Research a topic thoroughly by running multiple searches and fetching pages. ONLY use this when the user EXPLICITLY asks to search, look up, research, or find information (e.g. "검색해줘", "찾아봐", "알아봐줘"). Do NOT use this for general questions, coding help, or anything that does not explicitly request a web search.',
      parameters: {
        type: 'object',
        properties: {
          topic:       { type: 'string',  description: 'Topic or question to research' },
          queries:     { type: 'array',   items: { type: 'string' }, description: 'Optional: specific search queries to run (default: auto-generated from topic)' },
          max_sources: { type: 'integer', description: 'Max pages to fetch and read (default: 5)' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search DuckDuckGo and return result titles/URLs/snippets only. ONLY use when the user EXPLICITLY requests a search (e.g. "검색해줘", "찾아봐"). Do NOT use for general questions or anything that does not explicitly request a web search. For research questions, use web_research instead.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string',  description: 'Search query' },
          max_results: { type: 'integer', description: 'Number of results to return (default: 5, max: 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text content. Use this after web_search to read the full content of a page.',
      parameters: {
        type: 'object',
        properties: {
          url:       { type: 'string',  description: 'URL to fetch' },
          max_chars: { type: 'integer', description: 'Maximum characters to return (default: 8000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rag_search',
      description: '로컬 보안 지식베이스(KB)에서 관련 문서를 검색한다. 보안 기법·도구·취약점·페이로드 등 사실 확인이 필요할 때 가장 먼저 사용할 것(웹 검색보다 우선). 출처(문서명+섹션)가 함께 반환되며, 반드시 반환된 근거에만 기반해 답하고 KB에 없으면 "지식베이스에 없음"이라고 명시할 것.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string',  description: '검색할 질문이나 키워드' },
          top_k: { type: 'integer', description: '반환할 청크 수 (기본 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cve_lookup',
      description: '공식 NVD(미국 국가취약점DB)에서 CVE 상세를 조회한다. CVE 번호(예: CVE-2021-44228)에 대한 공식 설명·CVSS 점수·심각도·참고링크를 권위 출처(tier1)로 반환하며 지식베이스에 캐시한다. CVE 관련 질문엔 추측 대신 이 툴을 쓸 것.',
      parameters: {
        type: 'object',
        properties: {
          cve_id: { type: 'string', description: 'CVE 식별자 (예: CVE-2021-44228)' },
        },
        required: ['cve_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attack_lookup',
      description: '공식 MITRE ATT&CK에서 공격 전술/기법을 조회한다. 기법 번호(T1059, T1566.001) 또는 기법명(예: phishing)으로 전술·플랫폼·설명·탐지법을 권위 출처(tier1)로 반환한다.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '기법 번호(T####) 또는 기법명' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exploit_search',
      description: 'ExploitDB(공개 익스플로잇 DB)에서 익스플로잇을 검색한다. CVE 번호 또는 키워드로 공개 PoC/익스플로잇 목록(제목·플랫폼·URL)을 반환한다. 출처 신뢰등급: 커뮤니티(tier2).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'CVE 번호 또는 검색 키워드' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gtfobins_lookup',
      description: 'GTFOBins에서 유닉스 바이너리의 악용·권한상승 기법을 조회한다. 바이너리 이름(예: find, vim, tar)으로 가능한 기능(shell/suid/sudo 등)과 코드를 반환한다. 출처 신뢰등급: 커뮤니티(tier2).',
      parameters: {
        type: 'object',
        properties: { binary: { type: 'string', description: '유닉스 바이너리 이름 (예: find)' } },
        required: ['binary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lolbas_lookup',
      description: 'LOLBAS에서 윈도우 기본 바이너리(LOLBins)의 living-off-the-land 악용 기법을 조회한다. 바이너리 이름(예: certutil, mshta, regsvr32)으로 다운로드/실행/우회 명령과 카테고리를 반환한다. GTFOBins의 윈도우판. 출처 신뢰등급: 커뮤니티(tier2).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '윈도우 바이너리 이름 (예: certutil)' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dependency_lookup',
      description: '공식 패키지 레지스트리에서 라이브러리의 최신 버전·설명·deprecation과 알려진 취약점(OSV)을 조회한다. 라이브러리 버전/API는 추측하지 말고 반드시 이 툴로 확인할 것(모델 지식은 낡았을 수 있음). 런타임(node/python 등) 지원종료는 product만 주면 EOL을 반환.',
      parameters: {
        type: 'object',
        properties: {
          ecosystem: { type: 'string', enum: ['npm', 'pypi', 'crates', 'go'], description: '패키지 생태계' },
          name:      { type: 'string', description: '패키지/모듈 이름' },
          version:   { type: 'string', description: '취약점 확인할 특정 버전(선택)' },
          eol:       { type: 'string', description: '런타임/프레임워크 지원종료 조회 (예: nodejs, python, django). 주면 ecosystem/name 대신 EOL 반환' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Make an HTTP request with any method (GET, POST, PUT, PATCH, DELETE). Use this to call REST APIs, send webhooks, test endpoints, or interact with any HTTP service.',
      parameters: {
        type: 'object',
        properties: {
          method:  { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE','HEAD'], description: 'HTTP method' },
          url:     { type: 'string', description: 'Request URL' },
          headers: { type: 'object', description: 'Request headers as key-value pairs (optional)' },
          body:    { type: 'string', description: 'Request body — JSON string or plain text (optional)' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds (default: 30000)' },
        },
        required: ['method', 'url'],
      },
    },
  },
];

// ─── Dispatcher ────────────────────────────────────────────────────────────

export async function executeTool(name, params, pluginManager = null, backupManager = null) {
  // Try plugin tools first
  if (pluginManager) {
    const pluginResult = await pluginManager.tryExecute(name, params);
    if (pluginResult !== null) return pluginResult;
  }

  switch (name) {
    case 'read_file':        return toolReadFile(params);
    case 'write_file':       return toolWriteFile(params, backupManager);
    case 'delete_file':      return toolDeleteFile(params, backupManager);
    case 'move_file':        return toolMoveFile(params, backupManager);
    case 'copy_file':        return toolCopyFile(params);
    case 'list_directory':   return toolListDirectory(params);
    case 'run_code':         return toolRunCode(params);
    case 'create_directory': return toolCreateDirectory(params);
    case 'delete_directory': return toolDeleteDirectory(params);
    case 'edit_file':        return toolEditFile(params, backupManager);
    case 'find_files':       return toolFindFiles(params);
    case 'run_command':      return toolRunCommand(params);
    case 'search_files':     return toolSearchFiles(params);
    case 'web_research':     return toolWebResearch(params);
    case 'web_search':       return toolWebSearch(params);
    case 'web_fetch':        return toolWebFetch(params);
    case 'rag_search':       return toolRagSearch(params);
    case 'cve_lookup':       return toolCveLookup(params);
    case 'attack_lookup':    return toolAttackLookup(params);
    case 'exploit_search':   return toolExploitSearch(params);
    case 'gtfobins_lookup':  return toolGtfobinsLookup(params);
    case 'lolbas_lookup':    return toolLolbasLookup(params);
    case 'dependency_lookup': return toolDependencyLookup(params);
    case 'http_request':     return toolHttpRequest(params);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Implementations ───────────────────────────────────────────────────────

async function toolReadFile({ path: p }) {
  try {
    const full = resolve(process.cwd(), p);
    const content = await readFile(full, 'utf-8');
    return { success: true, path: full, content };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolWriteFile({ path: p, content = '' }, backupManager) {
  try {
    const full = resolve(process.cwd(), p);
    const chk  = sandboxCheck(full, 'Write target');
    if (chk) return chk;
    await backupManager?.backup(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
    return { success: true, path: full, message: `Written: ${p} (${content.length} chars)` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolDeleteFile({ path: p }, backupManager) {
  try {
    const full = resolve(process.cwd(), p);
    const chk  = sandboxCheck(full, 'Delete target');
    if (chk) return chk;
    await backupManager?.backup(full);
    await unlink(full);
    return { success: true, message: `Deleted: ${p}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolMoveFile({ source, destination }, backupManager) {
  try {
    const src  = resolve(process.cwd(), source);
    const dst  = resolve(process.cwd(), destination);
    const chkS = sandboxCheck(src, 'Move source');
    if (chkS) return chkS;
    const chkD = sandboxCheck(dst, 'Move destination');
    if (chkD) return chkD;
    await backupManager?.backup(src);
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    return { success: true, message: `Moved: ${source} → ${destination}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolCopyFile({ source, destination }) {
  try {
    const src  = resolve(process.cwd(), source);
    const dst  = resolve(process.cwd(), destination);
    // source outside project is fine (read-only); destination must be inside
    const chk  = sandboxCheck(dst, 'Copy destination');
    if (chk) return chk;
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return { success: true, message: `Copied: ${source} → ${destination}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolCreateDirectory({ path: p }) {
  try {
    const full = resolve(process.cwd(), p);
    const chk  = sandboxCheck(full, 'Directory');
    if (chk) return chk;
    await mkdir(full, { recursive: true });
    return { success: true, path: full, message: `Created directory: ${p}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolDeleteDirectory({ path: p, recursive = false }) {
  try {
    const full = resolve(process.cwd(), p);
    const chk  = sandboxCheck(full, 'Directory');
    if (chk) return chk;
    await rm(full, { recursive, force: recursive });
    return { success: true, message: `Deleted directory: ${p}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolEditFile({ path: p, old_string, new_string = '', replace_all = false }, backupManager) {
  try {
    const full = resolve(process.cwd(), p);
    const chk  = sandboxCheck(full, 'Edit target');
    if (chk) return chk;
    await backupManager?.backup(full);

    // old_string이 비어있으면 파일 전체를 new_string으로 덮어씁니다 (clear/overwrite)
    if (!old_string) {
      let old_content = '';
      try { old_content = await readFile(full, 'utf-8'); } catch { /* new file */ }
      await writeFile(full, new_string, 'utf-8');
      return { success: true, path: full, message: `Overwritten: ${p}`, old_content };
    }

    const content = await readFile(full, 'utf-8');

    if (!replace_all) {
      const count = content.split(old_string).length - 1;
      if (count === 0) return { error: `old_string not found in ${p}` };
      if (count > 1)   return { error: `old_string appears ${count} times in ${p} — use replace_all:true or make old_string more specific` };
    }

    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);

    await writeFile(full, updated, 'utf-8');

    const added = new_string.split('\n').length - old_string.split('\n').length;
    const sign  = added >= 0 ? `+${added}` : `${added}`;
    return { success: true, path: full, message: `Edited: ${p} (${sign} lines)` };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolFindFiles({ pattern, path: searchPath = '.', type: typeFilter = 'any' }) {
  try {
    const root    = resolve(process.cwd(), searchPath);
    const re      = globToRegex(pattern);
    const results = [];
    await findWalk(root, root, re, typeFilter, results);
    return { success: true, pattern, total: results.length, results };
  } catch (err) {
    return { error: err.message };
  }
}

function globToRegex(pattern) {
  // Order matters: protect **, then *, then escape regex specials
  const re = pattern
    .replace(/\*\*/g,  '\x00GLOBSTAR\x00')     // protect **
    .replace(/\*/g,    '\x00STAR\x00')          // protect *
    .replace(/\?/g,    '\x00ANY\x00')           // protect ?
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')      // escape regex specials
    .replace(/\x00GLOBSTAR\x00/g, '.*')         // ** → anything
    .replace(/\x00STAR\x00/g,     '[^/\\\\]*')  // *  → filename chars
    .replace(/\x00ANY\x00/g,      '[^/\\\\]');  // ?  → single char
  return new RegExp('^' + re + '$', 'i');
}

const FIND_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

async function findWalk(root, dir, re, typeFilter, results, depth = 0) {
  if (depth > 8 || results.length > 500) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }

  for (const e of entries) {
    const absPath = join(dir, e.name);
    const relPath = relative(root, absPath).replace(/\\/g, '/');

    if (e.isDirectory()) {
      if (FIND_SKIP.has(e.name)) continue;
      if ((typeFilter === 'dir' || typeFilter === 'any') && re.test(e.name)) {
        results.push({ path: relPath, type: 'dir' });
      }
      await findWalk(root, absPath, re, typeFilter, results, depth + 1);
    } else {
      if ((typeFilter === 'file' || typeFilter === 'any') && re.test(e.name)) {
        try {
          const s = await stat(absPath);
          results.push({ path: relPath, type: 'file', size: s.size });
        } catch {
          results.push({ path: relPath, type: 'file' });
        }
      }
    }
  }
}

async function toolListDirectory({ path: p = '.', depth: maxDepth = 1 }) {
  const clampedDepth = Math.min(Math.max(1, maxDepth ?? 1), 5);
  try {
    const full    = resolve(process.cwd(), p);
    const entries = await listRecursive(full, full, 0, clampedDepth);
    return { success: true, path: full, entries };
  } catch (err) {
    return { error: err.message };
  }
}

async function listRecursive(root, dir, currentDepth, maxDepth) {
  const raw   = await readdir(dir, { withFileTypes: true });
  const items = [];

  for (const e of raw) {
    const absPath = join(dir, e.name);
    const relPath = relative(root, absPath).replace(/\\/g, '/');

    if (e.isDirectory()) {
      const item = { name: relPath + '/', type: 'dir' };
      if (currentDepth < maxDepth - 1) {
        try { item.children = await listRecursive(root, absPath, currentDepth + 1, maxDepth); }
        catch { /* unreadable */ }
      }
      items.push(item);
    } else {
      const item = { name: relPath, type: 'file' };
      try { item.size = (await stat(absPath)).size; } catch { /* ignore */ }
      items.push(item);
    }
  }
  return items;
}

function spawnProcess(cmd, args, cwd, timeoutMs = 30_000, opts = {}) {
  return new Promise((resolveP) => {
    // 기본값 false: shell:true + 멀티라인 argv는 cmd.exe가 개행을 재해석해 코드를
    // 조용히 깨뜨린다(과거 run_code/run_command 버그의 근본원인). 셸이 꼭 필요한
    // 호출만 opts.shell:true를 명시한다. 멀티라인은 반드시 파일 경유로 실행할 것.
    const useShell = opts.shell ?? false;
    const proc = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      shell: useShell,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d; });
    proc.stderr?.on('data', (d) => { stderr += d; });
    proc.stdin?.end();

    const timer = setTimeout(() => {
      proc.kill();
      resolveP({ code: -1, stdout, stderr: stderr + '\n[Killed: timeout]' });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout: '', stderr: err.message });
    });
  });
}

/**
 * 코드/명령을 임시 파일에 써서 실행한다.
 * 이유: -c/-e 인자로 멀티라인 코드를 직접 넘기고 shell:true(Windows cmd.exe)를 거치면,
 * cmd.exe가 명령줄을 재구성하면서 인자 속 개행을 깨뜨려 코드가 한 줄로 뭉개지거나
 * 중간에서 잘린다 — 에러 없이 "성공"으로 끝나거나 엉뚱한 SyntaxError를 내는 조용한 버그.
 * 파일 경유 실행은 개행·따옴표 이슈를 원천적으로 피한다(shell:false로 인터프리터를 직접 실행).
 */
async function runViaTempFile(ext, content, buildArgs, cwd, timeoutMs) {
  const file = join(tmpdir(), `oh-run-${randomUUID()}.${ext}`);
  await writeFile(file, content, 'utf-8');
  try {
    const { cmd, args } = buildArgs(file);
    return await spawnProcess(cmd, args, cwd, timeoutMs, { shell: false });
  } finally {
    await unlink(file).catch(() => {});
  }
}

const MISSING_INTERPRETER_RE = /ENOENT|not recognized|not found|No such file/i;

async function toolRunCode({ language, code }) {
  let result;

  // 샌드박스(WSL) 모드면 격리 배포판 안에서 실행
  const sb = wrapCode(language, code);
  if (sb) {
    result = await spawnProcess(sb.cmd, sb.args, null, 30_000, { shell: sb.useShell });
  } else if (language === 'python') {
    result = await runViaTempFile('py', code, (f) => ({ cmd: 'python', args: [f] }), null, 30_000);
    if (result.code === -1 && MISSING_INTERPRETER_RE.test(result.stderr)) {
      result = await runViaTempFile('py', code, (f) => ({ cmd: 'python3', args: [f] }), null, 30_000);
    }
  } else if (language === 'node') {
    result = await runViaTempFile('cjs', code, (f) => ({ cmd: 'node', args: [f] }), null, 30_000);
  } else if (language === 'shell') {
    if (process.platform === 'win32') {
      result = await runViaTempFile('cmd', code, (f) => ({ cmd: 'cmd', args: ['/c', f] }), null, 30_000);
    } else {
      result = await runViaTempFile('sh', code, (f) => ({ cmd: 'bash', args: [f] }), null, 30_000);
    }
  } else {
    return { error: `Unsupported language: ${language}` };
  }

  return {
    success: result.code === 0,
    exit_code: result.code,
    stdout: result.stdout.slice(0, 10_000),
    stderr: result.stderr.slice(0, 5_000),
    sandbox: sandboxLabel(),
  };
}

async function toolRunCommand({ command, cwd, timeout }) {
  const timeoutMs = (typeof timeout === 'number' && timeout > 0) ? Math.min(timeout, 600_000) : 30_000;

  // 샌드박스(WSL) 모드면 격리 배포판 안에서 실행 (cwd는 OH_SANDBOX_CWD 사용)
  let result;
  const sb = wrapShellCommand(command);
  if (sb) {
    result = await spawnProcess(sb.cmd, sb.args, null, timeoutMs, { shell: sb.useShell });
  } else if (process.platform === 'win32') {
    result = await runViaTempFile('cmd', command, (f) => ({ cmd: 'cmd', args: ['/c', f] }), cwd, timeoutMs);
  } else {
    result = await runViaTempFile('sh', command, (f) => ({ cmd: 'bash', args: [f] }), cwd, timeoutMs);
  }
  return {
    success: result.code === 0,
    exit_code: result.code,
    stdout: result.stdout.slice(0, 10_000),
    stderr: result.stderr.slice(0, 5_000),
    sandbox: sandboxLabel(),
  };
}

// ─── search_files ─────────────────────────────────────────────────────────────

async function toolSearchFiles({ pattern, path: searchPath = '.', glob: globPat, case_insensitive = false, max_results = 50 }) {
  try {
    const root   = resolve(process.cwd(), searchPath);
    const flags  = case_insensitive ? 'i' : '';
    const re     = new RegExp(pattern, flags);
    const limit  = Math.min(Math.max(1, max_results), 200);
    const matches = [];

    await searchDir(root, root, re, globPat ?? null, matches, limit);

    if (matches.length === 0) {
      return { success: true, pattern, results: [], message: 'No matches found.' };
    }
    return { success: true, pattern, total: matches.length, results: matches };
  } catch (err) {
    return { error: err.message };
  }
}

async function searchDir(root, dir, re, globPat, matches, limit) {
  if (matches.length >= limit) return;

  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }

  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

  for (const entry of entries) {
    if (matches.length >= limit) return;
    if (entry.name.startsWith('.') && !globPat?.includes('.')) continue;

    const absPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      await searchDir(root, absPath, re, globPat, matches, limit);
    } else {
      // Glob filter (simple: match extension or wildcard)
      if (globPat) {
        const pat = globPat.replace(/\*\*/g, '*').replace(/\./g, '\\.').replace(/\*/g, '.*');
        if (!new RegExp(pat + '$').test(entry.name)) continue;
      }

      try {
        const info = await stat(absPath);
        if (info.size > 500_000) continue; // skip huge files

        const text  = await readFile(absPath, 'utf-8');
        const lines = text.split('\n');
        const rel   = relative(root, absPath).replace(/\\/g, '/');

        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      } catch { /* skip binary / unreadable */ }
    }
  }
}

// ─── Web tools ────────────────────────────────────────────────────────────────

// Rotate user agents to reduce DDG bot detection
const WEB_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

let _uaIndex = Math.floor(Math.random() * WEB_UAS.length);
function nextUA() {
  _uaIndex = (_uaIndex + 1) % WEB_UAS.length;
  return WEB_UAS[_uaIndex];
}

// Domain authority tiers — higher bonus = more trusted source
const DOMAIN_BOOST = [
  // Tier 1: 공식 문서 / 최고 권위 소스 (+0.8)
  [0.8, ['github.com', 'stackoverflow.com', 'mdn.', 'docs.python.org', 'docs.microsoft.com',
         'developer.mozilla.org', 'docs.docker.com', 'kubernetes.io', 'docs.aws.amazon.com',
         'cloud.google.com', 'docs.oracle.com', 'man7.org', 'w3.org',
         'nvd.nist.gov', 'cve.mitre.org', 'exploit-db.com', 'packetstormsecurity.com']],
  // Tier 2: 주요 커뮤니티 / 신뢰 플랫폼 (+0.5)
  [0.5, ['reddit.com', 'medium.com', 'dev.to', 'hashnode.dev',
         'naver.com', 'tistory.com', 'velog.io', 'brunch.co.kr',
         'npmjs.com', 'pypi.org', 'crates.io', 'packagist.org',
         'wikipedia.org', 'youtube.com',
         'portswigger.net', 'hackerone.com', 'bugcrowd.com',
         'owasp.org', 'sans.org', 'krebs', 'threatpost.com',
         'cvedetails.com', 'vuldb.com', 'snyk.io', 'cisa.gov',
         'qualys.com', 'tenable.com', 'rapid7.com', 'sonarqube.org']],
  // Tier 3: 알려진 기술 블로그 / IT 미디어 (+0.25)
  [0.25, ['infosec.exchange', 'bleepingcomputer.com', 'thehackernews.com',
          'zdnet.com', 'techcrunch.com', 'arstechnica.com', 'wired.com',
          'coding-factory', 'inpa.tistory', 'devlog', 'nareunharu',
          'itworld.co.kr', 'boannews.com']],
];

function domainBoost(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const [bonus, domains] of DOMAIN_BOOST) {
      if (domains.some(d => host.includes(d))) return bonus;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Score how relevant a search result is to a query.
 * Returns float (higher = more relevant). Domain authority adds a bonus on top.
 */
function relevanceScore(query, { title = '', snippet = '', url = '' }) {
  const tokens = query.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) ?? [];
  if (tokens.length === 0) return 1 + domainBoost(url);

  const t = title.toLowerCase();
  const s = snippet.toLowerCase();
  const u = url.toLowerCase();

  let score = 0;
  for (const tok of tokens) {
    if (t.includes(tok))       score += 1.0;  // title match: full weight
    else if (s.includes(tok))  score += 0.5;  // snippet match: half weight
    else if (u.includes(tok))  score += 0.2;  // url match: low weight
  }
  return (score / tokens.length) + domainBoost(url);
}

async function toolWebSearch({ query, max_results = 5 }) {
  const limit = Math.min(Math.max(1, max_results), 10);
  try {
    const res = await ddgSearch(query, limit * 2); // fetch extra, then re-rank
    if (!res.results) return res;
    const MIN_REL = 0.3;
    const ranked = res.results
      .map(r => ({ ...r, _rel: relevanceScore(query, r) }))
      .sort((a, b) => b._rel - a._rel)
      .filter(r => r._rel >= MIN_REL)
      .slice(0, limit)
      .map(({ _rel, ...r }) => r);

    // Auto-fetch top 5 pages in parallel
    const AUTO_FETCH = 5;
    const toFetch = ranked.slice(0, AUTO_FETCH);
    const fetched = await Promise.all(
      toFetch.map(r => toolWebFetch({ url: r.url, max_chars: 8000 }).then(f => ({
        ...r,
        page_content: f.error ? null : f.content,
      })).catch(() => r))
    );

    // Only keep results where fetch succeeded with real content
    const valid = fetched.filter(r => r.page_content && r.page_content.length > 100);

    // Deduplicate overlapping paragraphs across pages
    const seenKeys = new Set();
    const sections = valid.map((r, i) => {
      const paragraphs = r.page_content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      const unique = paragraphs.filter(p => {
        const key = p.slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      return `### 결과 ${i + 1}: ${r.title}\nURL: ${r.url}\n\n${unique.join('\n\n').slice(0, 3000)}`;
    }).join('\n\n---\n\n');

    return {
      ...res,
      results: valid.length > 0 ? valid : ranked,
      combined_content: valid.length > 0
        ? `다음은 "${query}" 검색 결과 실제 확인된 ${valid.length}개 페이지 내용입니다.\n반드시 아래 내용만 근거로 답변하고, 여기 없는 정보는 "확인되지 않음"이라고 하세요. URL은 아래 나온 것만 인용하세요.\n\n${sections}\n\n---\n⚠️ 언어 절대 규칙: 위 내용이 영어여도 반드시 한국어로만 답변할 것. 영어 단어 하나도 섞지 말 것. 이후 follow-up 질문에도 이 검색 결과를 계속 참고할 것.`
        : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolWebResearch({ topic, queries, max_sources = 5 }) {
  const limit = Math.min(Math.max(1, max_sources), 10);

  const searchQueries = Array.isArray(queries) && queries.length > 0
    ? queries.slice(0, 4)
    : generateQueries(topic);

  process.stderr.write(`\r  🔍 ${searchQueries.length}개 쿼리로 교차 검색 중...\n`);

  // Run all queries and collect results
  // URLs appearing in multiple query results get higher scores (cross-reference boost)
  const urlScores = new Map(); // url → { score, title, snippet }
  for (const q of searchQueries) {
    try {
      const res = await ddgSearch(q, 10);
      if (!res.results) continue;
      for (const r of res.results) {
        if (!r.url) continue;
        const rel = relevanceScore(topic, r);
        const entry = urlScores.get(r.url);
        if (entry) {
          entry.score += 1 + rel; // cross-reference boost
        } else {
          urlScores.set(r.url, { score: 1 + rel, title: r.title, snippet: r.snippet ?? '' });
        }
      }
    } catch { /* one query failing is fine */ }
  }

  if (urlScores.size === 0) {
    return { error: '검색 결과를 가져올 수 없습니다. 네트워크를 확인하세요.' };
  }

  // Sort by combined score descending, filter low-relevance, deduplicate domains, pick top N
  const MIN_SCORE = 0.3;
  const MIN_SCORE_FALLBACK = 0.15;

  const pickRanked = (minScore) => {
    const domainCount = new Map();
    const MAX_PER_DOMAIN = 2;
    return [...urlScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .filter(([url, meta]) => {
        if (meta.score < minScore) return false;
        try {
          const domain = new URL(url).hostname.replace(/^www\./, '');
          const cnt = domainCount.get(domain) ?? 0;
          if (cnt >= MAX_PER_DOMAIN) return false;
          domainCount.set(domain, cnt + 1);
          return true;
        } catch { return true; }
      })
      .slice(0, limit);
  };

  let ranked = pickRanked(MIN_SCORE);
  // Fallback: if too few results, relax threshold
  if (ranked.length < Math.min(3, limit)) {
    ranked = pickRanked(MIN_SCORE_FALLBACK);
  }

  // Fetch page content for each top URL in parallel
  process.stderr.write(`\r  📄 상위 ${ranked.length}개 페이지 읽는 중...\n`);
  const fetched = await Promise.all(ranked.map(async ([url, meta]) => {
    const f = await toolWebFetch({ url, max_chars: 10000 });
    const fetched_ok = !f.error && f.content?.length > 100;
    // Post-fetch relevance check: content must contain at least one topic keyword
    const topicTokens = topic.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) ?? [];
    const contentLow  = (f.content ?? '').toLowerCase();
    const contentRelevant = topicTokens.length === 0 ||
      topicTokens.some(tok => contentLow.includes(tok));
    const ok = fetched_ok && contentRelevant;
    process.stderr.write(`\r  ${ok ? '✓' : '✗'} ${url.slice(0, 70)}\n`);
    return { url, title: meta.title, snippet: meta.snippet, content: ok ? f.content : null, imageUrls: f.imageUrls ?? [] };
  }));

  // Prefer sources with full page content; fall back to snippet-only
  const withContent = fetched.filter(s => s.content && s.content.length > 100);
  const sources     = withContent.length > 0 ? withContent : fetched.filter(s => s.snippet);

  if (sources.length === 0) {
    return { error: '검색 결과를 찾을 수 없습니다. 검색어를 바꿔서 다시 시도하세요.' };
  }

  // Collect image URLs from all sources (deduplicated, max 6 total)
  const allImageUrls = [...new Set(fetched.flatMap(s => s.imageUrls ?? []))].slice(0, 6);

  // Count how many sources each paragraph appears in — boilerplate appears in 3+
  const paraCount = new Map();
  for (const s of sources) {
    const raw = s.content ?? s.snippet ?? '';
    const seen = new Set();
    for (const p of raw.split(/\n{2,}/)) {
      const key = p.trim().slice(0, 100).toLowerCase().replace(/\s+/g, ' ');
      if (key.length > 20 && !seen.has(key)) { seen.add(key); paraCount.set(key, (paraCount.get(key) ?? 0) + 1); }
    }
  }
  const isBoilerplate = (p) => {
    const key = p.trim().slice(0, 100).toLowerCase().replace(/\s+/g, ' ');
    return (paraCount.get(key) ?? 0) >= Math.min(3, sources.length);
  };

  const sections = sources.map((s, i) => {
    const raw = s.content ?? s.snippet ?? '';
    const paragraphs = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const body = paragraphs.filter(p => !isBoilerplate(p)).join('\n\n');
    const date = extractDate(raw) ?? extractDate(s.snippet ?? '');
    const dateLine = date ? `날짜: ${date}\n` : '';
    return `### 소스 ${i + 1}: ${s.title}\nURL: ${s.url}\n${dateLine}\n${body}`;
  }).join('\n\n---\n\n');

  const note = withContent.length === 0 ? ' (페이지 접근 실패 — 검색 스니펫만 포함)' : '';

  return {
    success:      true,
    topic,
    source_count: sources.length,
    imageUrls:    allImageUrls,
    summary:      `다음은 "${topic}"에 대해 실제로 확인한 ${sources.length}개 소스의 내용입니다${note}.\n반드시 아래 내용만 근거로 답변하고, 여기 없는 정보는 "확인되지 않음"이라고 하세요. URL은 아래 나온 것만 인용하세요.\n\n${sections}\n\n---\n⚠️ 언어 절대 규칙: 위 내용이 영어여도 반드시 한국어로만 답변할 것. 영어 단어 하나도 섞지 말 것. 이후 follow-up 질문에도 이 검색 결과를 계속 참고할 것.`,
  };
}

/** Generate 3–4 search queries from a topic string (Korean + English) */
function generateQueries(topic) {
  const base = topic.trim();
  const queries = [base];

  // Korean variation
  if (!/how|why|what|when|where|는|은|이|가|을|를/i.test(base)) {
    queries.push(`${base} 방법`);
  } else {
    queries.push(`${base} 정리`);
  }

  // English translation heuristic: if topic is mostly Korean, add English query
  const koreanRatio = (base.match(/[가-힣]/g) ?? []).length / base.length;
  if (koreanRatio > 0.3) {
    // Transliterate common security/tech terms to English for broader coverage
    const enMap = {
      '보안': 'security', '취약점': 'vulnerability', '해킹': 'hacking',
      '사이버': 'cyber', '공격': 'attack', '사고': 'incident',
      '최신': 'latest', '최근': 'recent', '방법': 'method',
      '분석': 'analysis', '도구': 'tool', '익스플로잇': 'exploit',
      '악성코드': 'malware', '랜섬웨어': 'ransomware', '피싱': 'phishing',
    };
    let enBase = base;
    for (const [ko, en] of Object.entries(enMap)) enBase = enBase.replaceAll(ko, en);
    // Only add if we actually translated something meaningful
    if (enBase !== base && /[a-z]{3,}/.test(enBase)) {
      queries.push(enBase.replace(/[가-힣]+/g, '').trim());
    }
  } else {
    // Already English-ish — add time-scoped variation with current year
    queries.push(`${base} ${new Date().getFullYear()}`);
  }

  return queries.filter(Boolean).slice(0, 4);
}

/** Extract the most recent date string from page content */
function extractDate(text) {
  if (!text) return null;
  // ISO / common date patterns — match most recent
  const patterns = [
    /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/g,           // 2025-04-17
    /(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/g,         // 2025년 4월 17일
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/gi, // April 17, 2025
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      // Try to parse year — only keep if reasonable (2020–2030)
      const year = parseInt(m[1] ?? m[3], 10);
      if (year >= 2020 && year <= 2030) found.push({ year, raw: m[0] });
    }
  }
  if (found.length === 0) return null;
  // Return the most recent year's first occurrence
  found.sort((a, b) => b.year - a.year);
  return found[0].raw;
}


async function naverSearch(query, limit) {
  const clientId     = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const params = new URLSearchParams({ query, display: Math.min(limit, 10), start: 1 });
  const res = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${params}`, {
    headers: {
      'X-Naver-Client-Id':     clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.items?.length) return null;

  const clean = s => s.replace(/<\/?b>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
  const results = data.items.map(r => ({
    title:   clean(r.title),
    url:     r.link,
    snippet: clean(r.description),
  }));
  return { success: true, query, source: 'naver', results };
}

async function ddgSearch(query, limit) {
  // 1. 네이버 검색 API (NAVER_CLIENT_ID/SECRET 환경변수 설정 시)
  process.stderr.write(`\r  🔍 검색 중...`);
  try {
    const nRes = await naverSearch(query, limit);
    if (nRes) {
      process.stderr.write(`\r  ✓ Naver (${nRes.results.length}개)          \n`);
      return nRes;
    }
  } catch { /* fall through */ }

  // 2. DDG fallback
  let html = await ddgFetchHtml(query, 'POST');
  if (!html) html = await ddgFetchHtml(query, 'GET');
  if (!html) html = await ddgFetchLite(query);
  if (!html) throw new Error('검색에 실패했습니다. 네트워크를 확인하세요.');

  const results = parseDdgHtml(html, limit);
  process.stderr.write(`\r  ✓ DDG (${results.length}개)          \n`);
  return {
    success: true, query, source: 'duckduckgo',
    results,
    ...(results.length === 0 ? { note: 'No results found — try a different query.' } : {}),
  };
}


// ── DuckDuckGo scraper ────────────────────────────────────────────────────────

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';

async function ddgFetchHtml(query, method = 'POST', retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ua  = nextUA();
      const qs  = `q=${encodeURIComponent(query)}&kl=us-en&kp=-1`;
      const url = method === 'POST' ? DDG_HTML_URL : `${DDG_HTML_URL}?${qs}`;

      const opts = {
        method,
        headers: {
          'User-Agent':      ua,
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Referer':         'https://duckduckgo.com/',
          'Cache-Control':   'no-cache',
        },
        redirect: 'follow',
        signal:   AbortSignal.timeout(20_000),
      };

      if (method === 'POST') {
        opts.body = qs;
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res = await fetch(url, opts);
      if (!res.ok) {
        if (res.status === 429 && attempt < retries) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const html = await res.text();
      // Sanity-check: must have at least one result link
      if (html.includes('result__a') || html.includes('result__url')) return html;
      // DDG returned a captcha or empty page — retry with next UA
    } catch (err) {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

async function ddgFetchLite(query) {
  try {
    const ua  = nextUA();
    const res = await fetch(`${DDG_LITE_URL}?q=${encodeURIComponent(query)}&kl=us-en`, {
      headers: {
        'User-Agent':      ua,
        'Accept':          'text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal:   AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function parseDdgHtml(html, limit) {
  const results = [];

  // ── Strategy A: split on web-result boundaries, pair link+snippet ─────────
  // blockRe lazy-stop was cutting off snippets that appear AFTER inner </div></div>
  // Fix: split HTML at each web-result opening tag, search each segment independently
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

  const segments = html.split(/<div[^>]+class="[^"]*web-result[^"]*"[^>]*>/);
  for (let i = 1; i < segments.length && results.length < limit; i++) {
    // Each segment runs until the next web-result boundary
    const seg       = segments[i];
    const linkMatch = linkRe.exec(seg);
    if (!linkMatch) continue;

    const url = extractDdgUrl(linkMatch[1]);
    if (!url) continue;

    const title = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!title) continue;

    const snipM   = snipRe.exec(seg);
    const snippet = snipM ? decodeEntities(stripTags(snipM[1])).trim() : '';

    results.push({ title, url, snippet });
  }

  // ── Strategy B: flat link+snippet scan (alternate layout fallback) ────────
  if (results.length === 0) {
    const allLinks = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    const allSnips = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];

    for (let i = 0; i < allLinks.length && results.length < limit; i++) {
      const url     = extractDdgUrl(allLinks[i][1]);
      const title   = decodeEntities(stripTags(allLinks[i][2])).trim();
      const snippet = allSnips[i] ? decodeEntities(stripTags(allSnips[i][1])).trim() : '';
      if (url && title) results.push({ title, url, snippet });
    }
  }

  // ── Strategy C: lite.duckduckgo.com layout ────────────────────────────────
  // <a class="result-link" href="...">title</a> ... <td class="result-snippet">snippet</td>
  if (results.length === 0) {
    const liteLinks = [...html.matchAll(/<a[^>]+class="result-link"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    const liteSnips = [...html.matchAll(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)];

    for (let i = 0; i < liteLinks.length && results.length < limit; i++) {
      const href    = liteLinks[i][1];
      const url     = href.startsWith('http') ? href : extractDdgUrl(href);
      const title   = decodeEntities(stripTags(liteLinks[i][2])).trim();
      const snippet = liteSnips[i] ? decodeEntities(stripTags(liteSnips[i][1])).trim() : '';
      if (url && title) results.push({ title, url, snippet });
    }
  }

  // ── Strategy D: generic anchor fallback — any href starting with http ─────
  if (results.length === 0) {
    const generic = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]{10,})"[^>]*>([\s\S]*?)<\/a>/g)];
    const seen    = new Set();
    for (const m of generic) {
      if (results.length >= limit) break;
      const url   = m[1];
      const title = decodeEntities(stripTags(m[2])).trim();
      // Skip DDG internal links, empty titles, duplicates
      if (!title || seen.has(url) || /duckduckgo\.com/i.test(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
  }

  return results;
}

function extractDdgUrl(href) {
  if (!href) return null;
  try {
    // Standard DDG redirect: /l/?uddg=<encoded>&rut=...
    if (href.startsWith('/l/?') || href.includes('uddg=')) {
      const qs  = href.includes('?') ? href.split('?')[1] : href;
      const val = new URLSearchParams(qs).get('uddg');
      if (val && val.startsWith('http')) return val;
    }
    // Already absolute
    if (href.startsWith('http')) return href;
    // Protocol-relative
    if (href.startsWith('//')) return 'https:' + href;
  } catch { /* fall through */ }
  return null;
}

async function toolWebFetch({ url, max_chars = 8000 }) {
  const limit = Math.min(Math.max(500, max_chars), 30_000);

  let rawHtml = null; // keep for image extraction

  // Direct fetch + HTML extraction
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': nextUA(), 'Accept': 'text/html,application/json,text/plain,*/*' },
      signal:   AbortSignal.timeout(20_000),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);

    const ct   = res.headers.get('content-type') ?? '';
    const body = await res.text();
    rawHtml = ct.includes('text/html') || ct.includes('xhtml') ? body : null;

    let content;
    if (ct.includes('application/json')) {
      try { content = JSON.stringify(JSON.parse(body), null, 2); }
      catch { content = body; }
    } else if (rawHtml) {
      content = htmlToText(body);
    } else {
      content = body;
    }

    const imageUrls = rawHtml ? extractImgUrls(rawHtml, url) : [];
    content = content.slice(0, limit);
    return { success: true, url, length: content.length, content, imageUrls };
  } catch (err) {
    return { error: err.message };
  }
}

/** Extract content image URLs from raw HTML, resolved to absolute URLs. */
function extractImgUrls(html, baseUrl) {
  const base = new URL(baseUrl);
  const urls = [];
  const seen = new Set();

  // Match src + data-src / data-lazy / data-original (lazy-load patterns)
  const RE = /<img[^>]+(?:src|data-src|data-lazy|data-original)=["']([^"'>\s]+)["'][^>]*>/gi;

  for (const m of html.matchAll(RE)) {
    const raw = m[1];
    if (!raw || raw.startsWith('data:')) continue; // skip base64 inline
    try {
      const abs = new URL(raw, base).href;
      const { hostname, pathname } = new URL(abs);
      const pathLow = pathname.toLowerCase();

      // Skip non-image formats
      if (/\.(svg|ico|cur|bmp|woff|ttf|eot)(\?|$)/i.test(pathLow)) continue;
      // Skip obvious UI/nav/placeholder images
      if (/\b(icon|favicon|logo|sprite|pixel|1x1|blank|spacer|arrow|btn|button|bg_|background|no.?image|placeholder|default.?img|empty)\b/i.test(pathLow)) continue;
      if (/[_\-](ico|btn|arrow|bg|nav|menu|bar|tag)[_\-\d.]/i.test(pathLow)) continue;
      // Skip very short filenames (tracking pixels, e.g. /t.gif)
      const filename = pathLow.split('/').pop().split('?')[0];
      if (filename.length < 5) continue;

      // Allow if: has known image extension OR is from a known image CDN/proxy
      const hasImgExt = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(pathLow);
      const isImgCdn  = /\b(daumcdn|kakaocdn|naver\.net|phinf|blogfiles|sstatic\.net|githubusercontent|cloudinary|imgix|twimg|fbcdn|ytimg|pinimg|wp\.com|i\.imgur)\b/i.test(hostname) ||
                        /\/(thumb|attach|upload|cdn|media|content|images?|photos?)\b/i.test(pathname);

      if (!hasImgExt && !isImgCdn) continue;

      if (seen.has(abs)) continue;
      seen.add(abs);
      urls.push(abs);
      if (urls.length >= 10) break;
    } catch { /* skip malformed */ }
  }
  return urls;
}

/** Fetch a page just to get its image URLs (used when Jina handles text). */
async function extractPageImages(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': nextUA(), 'Accept': 'text/html,*/*' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  return extractImgUrls(html, url);
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html) {
  // Step 1: Strip noise elements — ads, popups, cookie banners, nav, scripts, etc.
  let cleaned = html
    // Structural noise
    .replace(/<(script|style|noscript|svg|canvas|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Layout/UI elements
    .replace(/<(nav|header|footer|aside|dialog|menu|menuitem|form|button|input|select|textarea)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Ad/popup/cookie containers by common class/id patterns
    .replace(/<[^>]+(class|id)=["'][^"']*\b(ad|ads|advert|advertisement|banner|popup|modal|overlay|cookie|gdpr|consent|subscribe|newsletter|sidebar|widget|related|recommend|share|social|comment|comments|disqus|kakao-adfit|adsbygoogle|dfp-|gpt-)[^"']*["'][^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi, '')
    // Hidden elements
    .replace(/<[^>]+style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi, '')
    .replace(/<[^>]+style="[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi, '');

  // Step 2: Find main content area
  // Priority: <article> > <main> > role="main" > common content divs
  const mainPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i,
    /<div[^>]+id=["']?(content|main|article|post|body|entry|text|story|page-content|post-content|article-content|entry-content)["']?[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*(post-content|article-content|entry-content|story-content|blog-content|main-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*(content|article|post|entry|text|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let mainContent = '';
  for (const re of mainPatterns) {
    const m = re.exec(cleaned);
    if (m) {
      const candidate = (m[2] ?? m[1] ?? '');
      if (candidate.length > mainContent.length) mainContent = candidate;
    }
  }

  const source = mainContent.length > 300 ? mainContent : cleaned;

  // Step 3: Convert semantic elements to readable text
  const raw = decodeEntities(
    source
      .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `\n\n${stripTags(inner).trim()}\n`)
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,        (_, inner)       => `\n• ${stripTags(inner).trim()}`)
      .replace(/<\/(p|div|tr|section|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );

  // Step 4: Remove noisy lines — very short lines are usually nav/UI remnants
  const lines = raw.split('\n');
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true; // keep blank lines for spacing
    if (t.length < 10 && !/^[•\-*]/.test(t)) return false; // drop short non-list lines
    // Drop lines that look like pure navigation (pipe-separated menu items)
    if (/^(\s*[\w가-힣]{1,15}\s*[|·•]\s*){2,}/.test(t)) return false;
    return true;
  });

  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── rag_search ───────────────────────────────────────────────────────────────

async function toolRagSearch({ query, top_k = 5 }) {
  if (!query?.trim()) return { error: 'query is required' };
  try {
    const { searchHybrid } = await import('./rag.js');
    // 하이브리드(BM25+벡터 RRF). 게이트는 rag.js 내부(코사인≥0.5 또는 키워드매치+코사인≥0.35)
    // → 무관한 질의는 빈 결과로 "근거 없음" 유도.
    const hits = await searchHybrid(query, { topK: top_k });
    if (hits.length === 0) {
      return { results: [], note: '지식베이스에 관련 내용 없음. 이 사실을 답변에 명시하고, 근거 없는 내용을 생성하지 말 것.' };
    }
    const TIER_LABEL = { 1: '공식', 2: '커뮤니티', 3: '일반' };
    const results = hits.map(h => ({
      source:  h.source,
      section: h.heading || null,
      trust:   TIER_LABEL[h.tier] ?? '일반',
      score:   Number(h.score.toFixed(3)),
      content: h.body,
    }));
    return {
      results,
      note: '반드시 위 results의 내용에만 기반해 답하고, 출처(source/section)와 신뢰등급(trust)을 함께 밝힐 것. 공식>커뮤니티>일반 순으로 신뢰. results에 없는 내용은 생성 금지.',
    };
  } catch (err) {
    return { error: `rag_search 실패: ${err.message}` };
  }
}

// ─── cve_lookup (공식 CVE — NVD 점수 + MITRE 정본 이중화, tier1) ──────────────

const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;

// NVD: CVSS 점수·상세 분석의 표준 (enrichment 레이어).
async function fetchNvd(id) {
  // NVD 무키 한도는 5req/30s. NVD_API_KEY 환경변수가 있으면 한도 상향.
  const headers = { 'User-Agent': nextUA() };
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
  const res = await fetch(
    `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;   // 일시 오류 → 미가용 취급(MITRE로 폴백)
  const cve = (await res.json()).vulnerabilities?.[0]?.cve;
  if (!cve) return { found: false };
  const m = cve.metrics ?? {};
  const cvss = (m.cvssMetricV31?.[0] ?? m.cvssMetricV30?.[0])?.cvssData ?? m.cvssMetricV2?.[0]?.cvssData;
  return {
    found: true, status: cve.vulnStatus, published: cve.published,
    description: cve.descriptions?.find(d => d.lang === 'en')?.value ?? null,
    cvss: cvss ? { score: cvss.baseScore, severity: cvss.baseSeverity, vector: cvss.vectorString } : null,
    references: (cve.references ?? []).map(r => r.url),
  };
}

// MITRE CVE Program(cveawg): CVE 번호의 정본(canonical). NVD 백로그/누락 시 폴백.
async function fetchMitre(id) {
  const res = await fetch(`https://cveawg.mitre.org/api/cve/${encodeURIComponent(id)}`,
    { headers: { 'User-Agent': nextUA() }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const j = await res.json();
  const meta = j.cveMetadata, cna = j.containers?.cna;
  if (!meta) return { found: false };
  const mt = cna?.metrics?.find(x => x.cvssV3_1 || x.cvssV3_0);
  const c = mt?.cvssV3_1 || mt?.cvssV3_0;
  return {
    found: true, status: meta.state, published: meta.datePublished, assigner: meta.assignerShortName,
    description: cna?.descriptions?.find(d => d.lang === 'en')?.value ?? null,
    cvss: c ? { score: c.baseScore, severity: c.baseSeverity, vector: c.vectorString } : null,
    references: (cna?.references ?? []).map(r => r.url),
  };
}

async function toolCveLookup({ cve_id }) {
  const id = (cve_id || '').trim().toUpperCase();
  if (!CVE_RE.test(id)) return { error: `CVE 형식이 아님: "${cve_id}" (예: CVE-2021-44228)` };

  try {
    const nvd = await fetchNvd(id).catch(() => null);

    let core, source;
    if (nvd?.found && nvd.description) {
      core = nvd; source = 'NVD (공식)';
      if (!core.cvss) {                      // NVD에 점수 없으면 MITRE에서 보완 시도
        const mitre = await fetchMitre(id).catch(() => null);
        if (mitre?.found && mitre.cvss) core.cvss = mitre.cvss;
      }
    } else {
      const mitre = await fetchMitre(id).catch(() => null);
      if (mitre?.found) {
        core = mitre; source = 'MITRE CVE (공식 정본)';
        if (!core.cvss && nvd?.cvss) core.cvss = nvd.cvss;
      } else if (nvd?.found) {
        core = nvd; source = 'NVD (공식)';
      } else {
        return { found: false, source: 'NVD+MITRE', note: `공식 DB(NVD·MITRE)에 ${id} 없음. 추측하지 말 것.` };
      }
    }

    // 공식 보강(병렬): KEV(실제악용) + EPSS(악용확률) + GHSA(영향 패키지·패치).
    let exploited = null, epss = null, ghsa = null;
    try {
      const c = await import('./connectors.js');
      const [kev, ep, gh] = await Promise.all([c.kevLookup(id), c.epssLookup(id), c.ghsaForCve(id)]);
      if (kev) exploited = { in_cisa_kev: true, ransomware: kev.ransomware, due_date: kev.dueDate, added: kev.dateAdded };
      if (ep)  epss = { probability: ep.epss, percentile: ep.percentile };
      if (gh)  ghsa = { ghsa_id: gh.ghsa_id, severity: gh.severity, affected: gh.affected };
    } catch { /* 보강 실패 무시 */ }

    const result = {
      found:       true,
      id,
      source,
      tier:        1,
      status:      core.status ?? null,
      published:   core.published ?? null,
      description: core.description ?? null,
      cvss:        core.cvss ?? null,
      exploited,   // null이면 KEV 미등재
      epss,        // 악용확률 (EPSS, 0~1)
      ghsa,        // 영향 오픈소스 패키지·패치버전 (GitHub Advisory)
      references:  (core.references ?? []).slice(0, 6),
      note:        `공식 CVE 데이터(${source})${exploited ? ' + CISA KEV 실제악용중' : ''}${epss ? ` + EPSS 악용확률 ${(epss.probability * 100).toFixed(1)}%` : ''}. 이 정보에만 기반해 답하고 출처와 신뢰등급(공식)을 밝힐 것. 심각도(CVSS)·악용확률(EPSS)·실제악용(KEV)·영향SW(GHSA)를 종합해 우선순위를 제시할 것.`,
    };

    // tier1으로 KB에 캐시(오프라인·재사용). 비치명적.
    try {
      const { addDocument, TIER } = await import('./rag.js');
      const aff = ghsa?.affected?.length
        ? ghsa.affected.map(a => `${a.ecosystem}:${a.package} ${a.range}→${a.patched ?? '미패치'}`).join('; ')
        : '';
      const text =
        `# ${result.id} (${source})\n` +
        `심각도: ${result.cvss ? `${result.cvss.score} ${result.cvss.severity} (${result.cvss.vector})` : '미평가'}\n` +
        `악용확률(EPSS): ${epss ? `${(epss.probability * 100).toFixed(1)}% (상위 ${(epss.percentile * 100).toFixed(0)}%)` : '미상'}\n` +
        `실제악용: ${exploited ? `예 (CISA KEV${exploited.ransomware === 'Known' ? ', 랜섬웨어 사용 확인' : ''})` : '미확인'}\n` +
        `상태: ${result.status} | 공개: ${result.published}\n` +
        (aff ? `영향 패키지(GHSA): ${aff}\n` : '') + `\n` +
        `${result.description ?? ''}\n\n참고: ${result.references.join(', ')}`;
      await addDocument({ source: `CVE:${result.id}`, title: `${result.id} (${source})`, text, tier: TIER.OFFICIAL });
    } catch { /* 캐시 실패는 무시 */ }

    return result;
  } catch (err) {
    return { error: `cve_lookup 실패: ${err.message}` };
  }
}

// ─── attack_lookup (MITRE ATT&CK — 공식/tier1) ───────────────────────────────

async function toolAttackLookup({ query }) {
  if (!query?.trim()) return { error: 'query is required' };
  try {
    const { attackLookup } = await import('./connectors.js');
    const t = await attackLookup(query);
    if (!t) return { found: false, source: 'MITRE ATT&CK', note: `ATT&CK에 "${query}" 없음. 추측하지 말 것.` };

    // tier1으로 KB 캐시(오프라인·재사용)
    try {
      const { addDocument, TIER } = await import('./rag.js');
      const text = `# ${t.id} ${t.name} (MITRE ATT&CK 공식)\n전술: ${t.tactics.join(', ')} | 플랫폼: ${t.platforms.join(', ')}\n\n${t.description}\n\n탐지: ${t.detection ?? ''}\n참고: ${t.url}`;
      await addDocument({ source: `ATTACK:${t.id}`, title: `${t.id} ${t.name} (ATT&CK)`, text, tier: TIER.OFFICIAL });
    } catch { /* 캐시 실패 무시 */ }

    return {
      found: true, source: 'MITRE ATT&CK (공식)', tier: 1,
      id: t.id, name: t.name, tactics: t.tactics, platforms: t.platforms,
      description: t.description, detection: t.detection, url: t.url,
      note: '공식 ATT&CK 데이터. 이 정보에만 기반해 답하고 출처(MITRE ATT&CK, 공식)를 밝힐 것.',
    };
  } catch (err) {
    return { error: `attack_lookup 실패: ${err.message}` };
  }
}

// ─── exploit_search (ExploitDB — 커뮤니티/tier2) ─────────────────────────────

async function toolExploitSearch({ query }) {
  if (!query?.trim()) return { error: 'query is required' };
  try {
    const { exploitSearch } = await import('./connectors.js');
    const hits = await exploitSearch(query);
    if (hits.length === 0) return { results: [], note: 'ExploitDB에 해당 익스플로잇 없음. 추측하지 말 것.' };
    return {
      source: 'ExploitDB', tier: 2, results: hits,
      note: 'ExploitDB(커뮤니티/tier2) 데이터. 출처와 신뢰등급(커뮤니티)을 밝히고, 공식 권고와 구분할 것.',
    };
  } catch (err) {
    return { error: `exploit_search 실패: ${err.message}` };
  }
}

// ─── gtfobins_lookup (GTFOBins — 커뮤니티/tier2) ─────────────────────────────

async function toolGtfobinsLookup({ binary }) {
  if (!binary?.trim()) return { error: 'binary is required' };
  try {
    const { gtfobinsLookup } = await import('./connectors.js');
    const g = await gtfobinsLookup(binary);
    if (!g) return { found: false, source: 'GTFOBins', note: `GTFOBins에 "${binary}" 없음.` };
    return {
      found: true, source: 'GTFOBins', tier: 2,
      binary: g.binary, functions: g.functions, url: g.url, detail: g.detail,
      note: 'GTFOBins(커뮤니티/tier2) 데이터. 출처와 신뢰등급을 밝힐 것.',
    };
  } catch (err) {
    return { error: `gtfobins_lookup 실패: ${err.message}` };
  }
}

// ─── lolbas_lookup (LOLBAS — 윈도우 LOLBins, 커뮤니티/tier2) ──────────────────

async function toolLolbasLookup({ name }) {
  if (!name?.trim()) return { error: 'name is required' };
  try {
    const { lolbasLookup } = await import('./connectors.js');
    const r = await lolbasLookup(name);
    if (!r) return { found: false, source: 'LOLBAS', note: `LOLBAS에 "${name}" 없음.` };
    return {
      found: true, source: 'LOLBAS', tier: 2,
      name: r.name, commands: r.commands, url: r.url,
      note: 'LOLBAS(커뮤니티/tier2) 데이터. 출처와 신뢰등급을 밝힐 것.',
    };
  } catch (err) {
    return { error: `lolbas_lookup 실패: ${err.message}` };
  }
}

// ─── dependency_lookup (공식 레지스트리 — 라이브러리 최신성/취약점) ────────────

async function toolDependencyLookup({ ecosystem, name, version, eol }) {
  try {
    const conn = await import('./connectors.js');
    if (eol) {
      const cycles = await conn.eolLookup(eol);
      if (!cycles) return { found: false, note: `endoflife.date에 "${eol}" 없음.` };
      return { source: 'endoflife.date', product: eol, cycles, note: '런타임/프레임워크 지원종료 정보. 이 데이터에 기반해 답할 것.' };
    }
    if (!ecosystem || !name) return { error: 'ecosystem과 name 필요 (또는 eol)' };
    const r = await conn.depLookup({ ecosystem, name, version });
    if (r?.error) return r;
    if (!r?.found) return { found: false, ecosystem, name, note: `레지스트리에 "${name}" 없음. 추측하지 말 것.` };
    return {
      ...r,
      note: '공식 레지스트리의 실시간 데이터. 버전은 이 값을 쓰고 추측 금지. 취약점이 있으면 사용자에게 경고할 것.',
    };
  } catch (err) {
    return { error: `dependency_lookup 실패: ${err.message}` };
  }
}

// ─── http_request ─────────────────────────────────────────────────────────────

async function toolHttpRequest({ method, url, headers = {}, body, timeout = 30_000 }) {
  const m = (method ?? 'GET').toUpperCase();

  try {
    const reqHeaders = { 'User-Agent': 'ooh-cli/0.1', ...headers };

    // Auto Content-Type for body
    if (body && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
      try { JSON.parse(body); reqHeaders['Content-Type'] = 'application/json'; }
      catch { reqHeaders['Content-Type'] = 'text/plain'; }
    }

    const opts = {
      method:  m,
      headers: reqHeaders,
      signal:  AbortSignal.timeout(Math.min(timeout, 60_000)),
      redirect: 'follow',
    };
    if (body && m !== 'GET' && m !== 'HEAD') opts.body = body;

    const res  = await fetch(url, opts);
    const ct   = res.headers.get('content-type') ?? '';
    const raw  = await res.text();

    // Pretty-print JSON responses
    let responseBody = raw;
    if (ct.includes('application/json') || ct.includes('text/json')) {
      try { responseBody = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
    }

    // Collect response headers
    const resHeaders = {};
    for (const [k, v] of res.headers.entries()) resHeaders[k] = v;

    return {
      success:    res.ok,
      status:     res.status,
      statusText: res.statusText,
      headers:    resHeaders,
      body:       responseBody.slice(0, 20_000),
    };
  } catch (err) {
    return { error: err.message };
  }
}
