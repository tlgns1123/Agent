/**
 * Git helpers — context injection, commit workflow, branch management, GitHub API.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execP = promisify(exec);

// ─── Low-level runner ────────────────────────────────────────────────────────

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execP(`git ${args}`, {
      cwd: cwd || process.cwd(),
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (err) {
    return { ok: false, out: '', err: (err.stderr || err.message || '').trim() };
  }
}

// ─── Repo detection ──────────────────────────────────────────────────────────

export async function isGitRepo(cwd) {
  const r = await git('rev-parse --is-inside-work-tree', cwd);
  return r.ok;
}

// ─── System-prompt context ───────────────────────────────────────────────────

export async function getGitContext(cwd) {
  if (!(await isGitRepo(cwd))) return null;

  const [branch, status, log] = await Promise.all([
    git('branch --show-current', cwd),
    git('status --short', cwd),
    git('log --oneline -10', cwd),
  ]);

  const parts = [];
  if (branch.ok && branch.out) parts.push(`Branch: ${branch.out}`);
  if (status.ok && status.out) parts.push(`Status:\n${status.out}`);
  else if (status.ok)          parts.push('Status: clean');
  if (log.ok && log.out)       parts.push(`Recent commits:\n${log.out}`);

  return parts.length > 0
    ? `## Git\n\n${parts.join('\n\n')}`
    : null;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

export async function getGitDiff(cwd, { staged = false, file = null } = {}) {
  let cmd = staged ? 'diff --cached' : 'diff';
  if (file) cmd += ` -- "${file}"`;
  const r = await git(cmd, cwd);
  if (r.ok && r.out) return r.out;

  // fallback: diff against HEAD
  const r2 = await git(`diff HEAD${file ? ` -- "${file}"` : ''}`, cwd);
  return r2.ok ? r2.out : null;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function gitStatus(cwd) {
  const r = await git('status', cwd);
  return { ok: r.ok, out: r.ok ? r.out : r.err };
}

// ─── Branches ────────────────────────────────────────────────────────────────

export async function gitListBranches(cwd) {
  const r = await git('branch -a', cwd);
  return { ok: r.ok, out: r.ok ? r.out : r.err };
}

export async function gitCheckout(cwd, branch, create = false) {
  const cmd = create ? `checkout -b "${branch}"` : `checkout "${branch}"`;
  const r   = await git(cmd, cwd);
  return { ok: r.ok, message: r.ok ? (r.out || r.err || `Switched to ${branch}`) : r.err };
}

// ─── Staging & commit ────────────────────────────────────────────────────────

export async function gitAdd(cwd, paths = ['.']) {
  const joined = paths.map(p => `"${p}"`).join(' ');
  const r = await git(`add ${joined}`, cwd);
  return { ok: r.ok, message: r.ok ? 'Staged' : r.err };
}

export async function gitCommit(cwd, message) {
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r = await git(`commit -m "${escaped}"`, cwd);
  return { ok: r.ok, message: r.ok ? r.out : r.err };
}

export async function gitPush(cwd, remote = '', branch = '') {
  const extra = [remote, branch].filter(Boolean).join(' ');
  const r = await git(`push${extra ? ' ' + extra : ''}`, cwd);
  return { ok: r.ok, message: r.ok ? (r.out || r.err || 'Pushed') : r.err };
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

async function ghFetch(url, token) {
  const headers = {
    'Accept':     'application/vnd.github.v3+json',
    'User-Agent': 'ooh-cli/0.1',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function githubFetchIssue(owner, repo, number, token) {
  const data = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    token,
  );
  if (!data) return null;
  return {
    type:   data.pull_request ? 'PR' : 'Issue',
    number: data.number,
    title:  data.title,
    state:  data.state,
    body:   (data.body ?? '').slice(0, 3000),
    labels: (data.labels ?? []).map(l => l.name),
    author: data.user?.login,
    url:    data.html_url,
  };
}

export async function githubListIssues(owner, repo, token, { state = 'open', limit = 15 } = {}) {
  const data = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`,
    token,
  );
  if (!Array.isArray(data)) return null;
  return data.map(i => ({
    number: i.number,
    title:  i.title,
    state:  i.state,
    labels: (i.labels ?? []).map(l => l.name),
    author: i.user?.login,
    url:    i.html_url,
  }));
}
