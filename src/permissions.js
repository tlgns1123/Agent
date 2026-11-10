/**
 * Permission system — coding-agent style.
 *
 * Every write/delete/command tool call goes through checkPermission().
 * The user sees:
 *   [1] 이번만 허용
 *   [2] 세션 동안 허용
 *   [3] 거절
 *
 * Selecting 2 adds the group to the session whitelist so subsequent
 * calls of the same type are silently allowed.
 */

import chalk from 'chalk';

// ─── Tool → permission group mapping ─────────────────────────────────────────

export const TOOL_PERM_GROUP = {
  write_file:       'file:write',
  edit_file:        'file:write',
  copy_file:        'file:write',
  move_file:        'file:write',
  delete_file:      'file:delete',
  create_directory: 'dir:create',
  delete_directory: 'dir:delete',
  run_command:      'command',
  run_code:         'command',
  http_request:     'network:request',
};

const GROUP_TITLE = {
  'file:write':      '파일 쓰기 / 수정',
  'file:delete':     '파일 삭제',
  'dir:create':      '폴더 생성',
  'dir:delete':      '폴더 삭제',
  'command':         '명령 실행',
  'network:request': 'HTTP 요청',
};

// ─── PermissionManager ────────────────────────────────────────────────────────

export class PermissionManager {
  constructor() {
    // Groups allowed for the entire session
    this._sessionAllowed = new Set();
  }

  /** Returns true if this tool type needs a permission check. */
  needs(toolName) {
    return toolName in TOOL_PERM_GROUP;
  }

  /** Returns true if the group is already session-allowed. */
  sessionAllowed(toolName) {
    const g = TOOL_PERM_GROUP[toolName];
    return g ? this._sessionAllowed.has(g) : true;
  }

  /**
   * Ask the user for permission.
   * askFn(displayLabel, groupTitle) → Promise<'1'|'2'|'3'|string>
   * Returns true = allowed, false = denied.
   */
  async request(toolName, params, askFn) {
    if (!this.needs(toolName)) return true;
    // GET / HEAD are read-only — skip permission check
    if (toolName === 'http_request') {
      const m = (params.method ?? 'GET').toUpperCase();
      if (m === 'GET' || m === 'HEAD') return true;
    }
    if (this.sessionAllowed(toolName)) return true;

    const group = TOOL_PERM_GROUP[toolName];
    const label = buildLabel(toolName, params);
    const choice = await askFn(label, GROUP_TITLE[group] ?? group);

    if (choice === '2') {
      this._sessionAllowed.add(group);
      return true;
    }
    return choice === '1';
  }

  /** List what's currently session-allowed. */
  summary() {
    if (this._sessionAllowed.size === 0) return '(없음)';
    return [...this._sessionAllowed]
      .map((g) => GROUP_TITLE[g] ?? g)
      .join(', ');
  }
}

// ─── Permission prompt UI ─────────────────────────────────────────────────────

/**
 * Print the permission dialog and read a choice via rl.
 * Returns '1', '2', or '3'.
 */
export function makeAskFn(rl) {
  return (label, groupTitle) =>
    new Promise((resolve) => {
      const bar = chalk.dim('  ' + '─'.repeat(52));

      process.stdout.write('\n');
      console.log(bar);
      console.log(`  ${chalk.bold.yellow('⚠')}  ${chalk.white(label)}`);
      console.log(bar);
      console.log(`  ${chalk.dim('작업 유형: ')}${chalk.yellow(groupTitle)}`);
      console.log();
      console.log(`  ${chalk.cyan('[1]')}  이번만 허용`);
      console.log(`  ${chalk.cyan('[2]')}  세션 동안 허용`);
      console.log(`  ${chalk.red('[3]')}  거절`);
      console.log(bar);

      rl.question(chalk.dim('  선택 (1/2/3, 기본: 3): '), (ans) => {
        const trimmed = ans.trim();
        if (trimmed === '1' || trimmed === '2') {
          resolve(trimmed);
        } else {
          resolve('3');
        }
      });
    });
}

// ─── Label builder ────────────────────────────────────────────────────────────

function buildLabel(toolName, params) {
  const shorten = (s, n = 55) => {
    const str = String(s ?? '');
    return str.length > n ? '…' + str.slice(-(n - 1)) : str;
  };

  switch (toolName) {
    case 'write_file':
      return `파일 쓰기  ${chalk.white(shorten(params.path))}`;
    case 'edit_file':
      return `파일 수정  ${chalk.white(shorten(params.path))}`;
    case 'copy_file':
      return `파일 복사  ${chalk.dim(shorten(params.source, 25))} → ${chalk.white(shorten(params.destination, 25))}`;
    case 'move_file':
      return `파일 이동  ${chalk.dim(shorten(params.source, 25))} → ${chalk.white(shorten(params.destination, 25))}`;
    case 'delete_file':
      return `파일 삭제  ${chalk.red(shorten(params.path))}`;
    case 'create_directory':
      return `폴더 생성  ${chalk.white(shorten(params.path))}`;
    case 'delete_directory':
      return `폴더 삭제  ${chalk.red(shorten(params.path))}`;
    case 'run_command':
      return `명령 실행  ${chalk.white('$ ' + shorten(params.command, 50))}`;
    case 'run_code':
      return `코드 실행  ${chalk.dim(`(${params.language})`)} ${chalk.white(shorten((params.code ?? '').split('\n')[0], 45))}`;
    case 'http_request': {
      const method = (params.method ?? 'GET').toUpperCase();
      const color  = ['DELETE','PATCH','PUT','POST'].includes(method) ? chalk.yellow : chalk.white;
      return `HTTP ${color(method.padEnd(7))} ${chalk.white(shorten(params.url, 45))}`;
    }
    default:
      return toolName;
  }
}
