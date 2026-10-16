import chalk from 'chalk';

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function printWelcome(model) {
  console.log();
  console.log(chalk.bold.cyan('  ██████╗  ██████╗ ██╗  ██╗'));
  console.log(chalk.bold.cyan('  ██╔══██╗██╔═══██╗██║  ██║'));
  console.log(chalk.bold.cyan('  ██║  ██║██║   ██║███████║'));
  console.log(chalk.bold.cyan('  ██║  ██║██║   ██║██╔══██║'));
  console.log(chalk.bold.cyan('  ██████╔╝╚██████╔╝██║  ██║'));
  console.log(chalk.bold.cyan('  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝'));
  console.log();
  console.log(chalk.dim('  Ollama Helper v0.1.0'));
  console.log(chalk.dim(`  Model : ${chalk.cyan(model)}`));
  console.log(chalk.dim(`  Dir   : ${chalk.white(process.cwd())}`));
  console.log(chalk.dim('  Type /help for commands'));
  console.log();
}

// ─── Chat output ──────────────────────────────────────────────────────────────

export function printAssistantLabel() {
  process.stdout.write(chalk.cyan.bold('\nAssistant: '));
}

export function printToken(token) {
  process.stdout.write(chalk.white(token));
}

export function printThinkingStart() {
  process.stdout.write(chalk.dim('\n  ◌ thinking...'));
}

export function printThinkingEnd(elapsedMs) {
  const s = (elapsedMs / 1000).toFixed(1);
  process.stdout.write(`\r${chalk.dim(`  ◌ thought for ${s}s`)}\n`);
}

// ─── Tool use ─────────────────────────────────────────────────────────────────

export function printToolUse(name, params) {
  const icon  = TOOL_ICONS[name] ?? '⚙';
  const label = TOOL_LABELS[name] ?? name;
  const hint  = toolHint(name, params);
  process.stdout.write('\n');
  console.log(chalk.yellow(`  ${icon} ${chalk.bold(label)}`) + (hint ? chalk.dim(` ${hint}`) : ''));
}

export function printToolResult(success, message) {
  if (success) {
    console.log(chalk.green(`  ✓ ${message}`));
  } else {
    console.log(chalk.red(`  ✗ ${message}`));
  }
}

// ─── Rich file diff (Claude Code style) ───────────────────────────────────────

/**
 * Show a colored diff for edit_file.
 * old_string shown in red (-), new_string shown in green (+).
 */
export function printEditDiff(filePath, oldStr, newStr) {
  const oldLines = String(oldStr ?? '').split('\n');
  const newLines = String(newStr ?? '').split('\n');

  const col     = 70;
  const bar     = chalk.dim('  ' + '─'.repeat(col));
  const relPath = filePath.replace(/\\/g, '/');

  console.log();
  console.log(`  ${chalk.bold.white(relPath)}`);
  console.log(bar);

  const MAX_SHOW = 40; // max lines to display before truncating
  const delLines = oldLines.filter(l => l !== '' || oldLines.length > 1);
  const addLines = newLines.filter(l => l !== '' || newLines.length > 1);

  // Print removed lines
  if (delLines.length > 0) {
    const show = delLines.slice(0, MAX_SHOW);
    for (const l of show) console.log(chalk.red(`  - ${l}`));
    if (delLines.length > MAX_SHOW)
      console.log(chalk.dim(`  - … (${delLines.length - MAX_SHOW} more lines)`));
  }

  // Print added lines
  if (addLines.length > 0) {
    const show = addLines.slice(0, MAX_SHOW);
    for (const l of show) console.log(chalk.green(`  + ${l}`));
    if (addLines.length > MAX_SHOW)
      console.log(chalk.dim(`  + … (${addLines.length - MAX_SHOW} more lines)`));
  }

  if (delLines.length === 0 && addLines.length === 0) {
    console.log(chalk.dim('  (변경 없음)'));
  }

  const delta = newLines.length - oldLines.length;
  const sign  = delta >= 0 ? `+${delta}` : `${delta}`;
  const stats = chalk.dim(`  ${sign} lines`) + '  ' +
                chalk.red(`-${oldLines.length}`) + '  ' +
                chalk.green(`+${newLines.length}`);
  console.log(bar);
  console.log(stats);
}

/**
 * Show a brief summary for write_file (new file or overwrite).
 */
export function printWriteSummary(filePath, content) {
  const lines   = content.split('\n');
  const relPath = filePath.replace(/\\/g, '/');
  const col     = 70;
  const bar     = chalk.dim('  ' + '─'.repeat(col));

  console.log();
  console.log(`  ${chalk.bold.white(relPath)}  ${chalk.dim(`(${lines.length} lines, ${content.length} chars)`)}`);
  console.log(bar);

  // Preview first 6 lines
  const preview = lines.slice(0, 6);
  for (const line of preview) {
    console.log(chalk.green(`  + ${line}`));
  }
  if (lines.length > 6) {
    console.log(chalk.dim(`  + … (${lines.length - 6} more lines)`));
  }
  console.log(bar);
}

// ─── Command output ───────────────────────────────────────────────────────────

/**
 * Styled output for run_command / run_code.
 * Git diffs get red/green coloring; npm gets emoji badge; generic has box.
 */
export function printCommandOutput(command, result) {
  const cmd    = (command ?? '').trim();
  const isGit  = /^git\b/.test(cmd);
  const isNpm  = /^npm\b/.test(cmd);
  const isPwsh = /^(powershell|pwsh)\b/i.test(cmd);
  const col    = 70;
  const bar    = chalk.dim('  ' + '─'.repeat(col));

  // ── header
  let badge;
  if (isGit)      badge = chalk.bold.yellow(' git ');
  else if (isNpm) badge = chalk.bold.red(' npm ');
  else            badge = chalk.bold.dim(' cmd ');

  const cmdBody = cmd.length > col - 10 ? cmd.slice(0, col - 10) + '…' : cmd;
  console.log(`\n  ${badge}  ${chalk.white(cmdBody)}`);
  console.log(bar);

  // ── stdout
  if (result.stdout?.trim()) {
    const lines = result.stdout.trimEnd().split('\n');
    for (const line of lines) {
      console.log(colorCommandLine(line, isGit));
    }
  }

  // ── stderr (only on failure, or always for npm warnings)
  if (result.stderr?.trim() && (!result.success || isNpm)) {
    const lines = result.stderr.trimEnd().split('\n');
    for (const line of lines) {
      const isWarn = /^npm warn/i.test(line);
      console.log(isWarn ? chalk.yellow(`  ${line}`) : chalk.red(`  ${line}`));
    }
  }

  // ── footer
  const exitBadge = result.success
    ? chalk.green(`  exit 0`)
    : chalk.red(`  exit ${result.exit_code}`);
  console.log(bar);
  console.log(exitBadge);
}

function colorCommandLine(line, isGit) {
  if (!isGit) return chalk.dim(`  ${line}`);

  // git diff coloring
  if (line.startsWith('+++') || line.startsWith('---')) return chalk.dim(`  ${line}`);
  if (line.startsWith('+'))  return chalk.green(`  ${line}`);
  if (line.startsWith('-'))  return chalk.red(`  ${line}`);
  if (line.startsWith('@@')) return chalk.cyan(`  ${line}`);
  if (/^(commit |Author:|Date:)/.test(line)) return chalk.yellow(`  ${line}`);

  // git status coloring
  if (/^\s*(modified|deleted):/.test(line))  return chalk.red(`  ${line}`);
  if (/^\s*(new file|renamed):/.test(line))  return chalk.green(`  ${line}`);
  if (/^(\?\?|!!)/.test(line))               return chalk.dim(`  ${line}`);

  return chalk.dim(`  ${line}`);
}

// ─── Misc output ──────────────────────────────────────────────────────────────

export function printTokenCount(evalCount, evalDurationNs) {
  const toks = evalCount ? chalk.dim(`${evalCount} tokens`) : '';
  const speed = (evalCount && evalDurationNs)
    ? chalk.dim(`  ${(evalCount / (evalDurationNs / 1e9)).toFixed(1)} tok/s`)
    : '';
  if (toks) process.stdout.write(chalk.dim(`\n  ${toks}${speed}\n`));
}

export function printError(msg) {
  console.log(chalk.red(`\n  ✗ ${msg}`));
}

export function printSystem(msg) {
  console.log(chalk.dim(`\n  ${msg}`));
}

export function printInfo(msg) {
  console.log(chalk.blue(`\n  ℹ ${msg}`));
}

export function getUserPrompt(model) {
  return chalk.green.bold('You') + chalk.dim(` [${model}]`) + chalk.green.bold('> ');
}

// ─── Status panel ─────────────────────────────────────────────────────────────

export function printStatus(state) {
  const ctxLabel = state.contextLength
    ? `${(state.contextLength / 1024).toFixed(0)}K`
    : 'default';

  const effort = state.config?.effort ?? 'normal';
  const rows = [
    ['Model',    chalk.cyan(state.model)],
    ['Context',  chalk.yellow(ctxLabel)],
    ['Effort',   chalk.cyan(effort)],
    ['Tool mode',chalk.white(state.toolMode)],
    ['Messages', chalk.white(String(state.messages.length))],
    ['Dir',      chalk.dim(process.cwd())],
  ];

  console.log(`\n${chalk.bold('  Status')}\n`);
  for (const [k, v] of rows) {
    console.log(`  ${chalk.dim(k.padEnd(12))}${v}`);
  }
  console.log();
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(label) {
  let frame = 0;
  let drawn = false;
  const id  = setInterval(() => {
    process.stdout.write(
      `\r  ${chalk.cyan(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length])} ${chalk.dim(label)}`
    );
    drawn = true;
  }, 80);

  return function stop() {
    clearInterval(id);
    if (drawn) {
      process.stdout.write('\r' + ' '.repeat(label.length + 8) + '\r');
    }
  };
}

// ─── CodeBlockFilter ──────────────────────────────────────────────────────────

/**
 * Buffers streaming tokens that fall inside fenced code blocks (```).
 * Non-code content is returned immediately via `display`.
 * Completed code blocks are returned via `blocks: [{lang, code}]` so the
 * caller can render them all at once.
 */
export class CodeBlockFilter {
  constructor() {
    this._buf     = '';   // partial-match lookahead buffer
    this._inCode  = false;
    this._lang    = '';
    this._codeBuf = '';
  }

  push(token) {
    this._buf += token;
    let display = '';
    const blocks = [];

    while (this._buf.length > 0) {
      if (this._inCode) {
        // Looking for closing ```
        const close = this._buf.indexOf('\n```');
        if (close !== -1) {
          // Accumulate everything before the closing fence
          this._codeBuf += this._buf.slice(0, close);
          // Skip past \n``` and optional trailing language tag / newline
          const after = this._buf.slice(close + 4);
          const nlPos = after.indexOf('\n');
          this._buf = nlPos !== -1 ? after.slice(nlPos + 1) : '';
          blocks.push({ lang: this._lang, code: this._codeBuf });
          this._inCode  = false;
          this._lang    = '';
          this._codeBuf = '';
          continue;
        }
        // No closing fence yet — hold back the last 3 chars in case ``` is split
        const hold = Math.min(this._buf.length, 3);
        this._codeBuf += this._buf.slice(0, this._buf.length - hold);
        this._buf = this._buf.slice(this._buf.length - hold);
        break;
      } else {
        // Looking for opening ```
        const open = this._buf.indexOf('```');
        if (open !== -1) {
          display += this._buf.slice(0, open);
          const rest = this._buf.slice(open + 3);
          // Extract optional language identifier (up to newline)
          const nl = rest.indexOf('\n');
          if (nl === -1) {
            // Haven't received the newline yet — hold the partial fence
            this._buf = '```' + rest;
            break;
          }
          this._lang    = rest.slice(0, nl).trim();
          this._buf     = rest.slice(nl + 1);
          this._inCode  = true;
          this._codeBuf = '';
          continue;
        }
        // No fence — hold back last 2 chars in case ``` is split across tokens
        const hold = Math.min(this._buf.length, 2);
        display  += this._buf.slice(0, this._buf.length - hold);
        this._buf = this._buf.slice(this._buf.length - hold);
        break;
      }
    }

    return { display, blocks };
  }

  flush() {
    // If still inside a code block, emit it as-is (unclosed)
    if (this._inCode) {
      const blocks = [{ lang: this._lang, code: this._codeBuf + this._buf }];
      this._inCode  = false;
      this._codeBuf = '';
      this._buf     = '';
      return { display: '', blocks };
    }
    const display = this._buf;
    this._buf = '';
    return { display, blocks: [] };
  }
}

/**
 * Render a completed code block all at once.
 */
export function printCodeBlock(lang, code) {
  const lines  = code.split('\n');
  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const col    = 70;
  const bar    = chalk.dim('  ' + '─'.repeat(col));
  const header = lang ? chalk.dim(`  \`\`\`${lang}`) : chalk.dim('  ```');

  console.log(header);
  console.log(bar);

  const MAX = 60;
  const show = lines.slice(0, MAX);
  for (const line of show) {
    process.stdout.write(chalk.white(`  ${line}\n`));
  }
  if (lines.length > MAX) {
    console.log(chalk.dim(`  … (${lines.length - MAX} more lines)`));
  }

  console.log(bar);
  console.log(chalk.dim('  ```'));
}

// ─── ThinkFilter ──────────────────────────────────────────────────────────────

export class ThinkFilter {
  constructor() {
    this._buf     = '';
    this._inThink = false;
    this._thinkMs = null;
    this.hadThink = false;
  }

  push(token) {
    this._buf += token;
    let display      = '';
    let enteredThink = false;
    let exitedThink  = false;
    let elapsedMs    = null;

    while (this._buf.length > 0) {
      if (this._inThink) {
        const end = this._buf.indexOf('</think>');
        if (end !== -1) {
          this._buf     = this._buf.slice(end + '</think>'.length);
          this._inThink = false;
          exitedThink   = true;
          elapsedMs     = this._thinkMs != null ? Date.now() - this._thinkMs : null;
          this._thinkMs = null;
          continue;
        }
        const partial = partialSuffix(this._buf, '</think>');
        if (partial > 0) {
          this._buf = this._buf.slice(this._buf.length - partial);
        } else {
          this._buf = '';
        }
        break;
      } else {
        const start = this._buf.indexOf('<think>');
        if (start !== -1) {
          display       += this._buf.slice(0, start);
          this._buf      = this._buf.slice(start + '<think>'.length);
          this._inThink  = true;
          this._thinkMs  = Date.now();
          if (!this.hadThink) { this.hadThink = true; enteredThink = true; }
          continue;
        }
        const partial = partialSuffix(this._buf, '<think>');
        if (partial > 0) {
          display   += this._buf.slice(0, this._buf.length - partial);
          this._buf  = this._buf.slice(this._buf.length - partial);
        } else {
          display   += this._buf;
          this._buf  = '';
        }
        break;
      }
    }

    return { display, enteredThink, exitedThink, elapsedMs };
  }

  flush() {
    const out  = this._inThink ? '' : this._buf;
    this._buf  = '';
    return out;
  }
}

function partialSuffix(str, tag) {
  for (let len = Math.min(str.length, tag.length - 1); len > 0; len--) {
    if (str.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

// ─── Tool icons / labels / hints ──────────────────────────────────────────────

const TOOL_ICONS = {
  read_file:       '📄',
  write_file:      '✏️ ',
  edit_file:       '✏️ ',
  delete_file:     '🗑 ',
  move_file:       '↔️ ',
  copy_file:       '📋',
  create_directory:'📁',
  list_directory:  '📂',
  find_files:      '🔍',
  search_files:    '🔎',
  run_command:     '▶ ',
  run_code:        '⚡',
  web_search:      '🌐',
  web_fetch:       '🌐',
  http_request:    '🔗',
};

const TOOL_LABELS = {
  read_file:       'Read',
  write_file:      'Write',
  edit_file:       'Edit',
  delete_file:     'Delete',
  move_file:       'Move',
  copy_file:       'Copy',
  create_directory:'Mkdir',
  list_directory:  'List',
  find_files:      'Find',
  search_files:    'Search',
  run_command:     'Run',
  run_code:        'Code',
  web_search:      'Search',
  web_fetch:       'Fetch',
  http_request:    'HTTP',
};

function toolHint(name, params) {
  switch (name) {
    case 'read_file':       return chalk.dim(shorten(params.path, 60));
    case 'write_file':      return chalk.dim(shorten(params.path, 60));
    case 'edit_file':       return chalk.dim(shorten(params.path, 60));
    case 'delete_file':     return chalk.dim(shorten(params.path, 60));
    case 'move_file':       return chalk.dim(`${shorten(params.source, 30)} → ${shorten(params.destination, 30)}`);
    case 'copy_file':       return chalk.dim(`${shorten(params.source, 30)} → ${shorten(params.destination, 30)}`);
    case 'create_directory':return chalk.dim(shorten(params.path, 60));
    case 'list_directory':  return chalk.dim(shorten(params.path ?? '.', 60));
    case 'find_files':      return chalk.dim(`${params.pattern} in ${shorten(params.path ?? '.', 40)}`);
    case 'search_files':    return chalk.dim(`"${shorten(params.pattern, 30)}" in ${shorten(params.path ?? '.', 30)}`);
    case 'run_command':     return chalk.white(`$ ${shorten(params.command, 60)}`);
    case 'run_code':        return chalk.dim(`(${params.language})`);
    case 'web_search':      return chalk.dim(`"${shorten(params.query, 50)}"`);
    case 'web_fetch':       return chalk.dim(shorten(params.url, 60));
    case 'http_request':    return chalk.white(`${(params.method ?? 'GET').toUpperCase()} ${shorten(params.url, 55)}`);
    default:                return '';
  }
}

function shorten(str, max) {
  const s = String(str ?? '');
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}
