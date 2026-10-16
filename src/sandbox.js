/**
 * OH — 실행 격리 샌드박스 (Phase 4)
 *
 * run_command / run_code 를 호스트(윈도우)가 아니라 격리된 WSL 배포판 안에서
 * 실행하도록 라우팅한다. "PC 안 망가뜨림" 제약의 핵심.
 *
 * 기본은 host(기존 동작). OH_SANDBOX=wsl 로 켜면 전용 배포판으로 보낸다.
 *
 * env:
 *   OH_SANDBOX         host|wsl   (기본 host)
 *   OH_SANDBOX_DISTRO  WSL 배포판 이름 (기본 kali-linux)
 *   OH_SANDBOX_USER    실행 사용자 (기본 root)
 *   OH_SANDBOX_CWD     명령 실행 디렉터리 (기본 배포판 기본값, 보통 ~)
 *
 * WSL 호출은 spawn(shell:false)로 argv를 직접 전달한다 → cmd.exe 따옴표
 * 재해석을 피해 임의 명령/코드를 안전하게 넘긴다.
 */

import { spawnSync } from 'child_process';

export function sandboxMode() {
  return (process.env.OH_SANDBOX ?? 'host').toLowerCase() === 'wsl' ? 'wsl' : 'host';
}
export function sandboxEnabled() { return sandboxMode() === 'wsl'; }
export function sandboxDistro()  { return process.env.OH_SANDBOX_DISTRO || 'kali-linux'; }
export function sandboxUser()    { return process.env.OH_SANDBOX_USER   || 'root'; }
export function sandboxCwd()     { return process.env.OH_SANDBOX_CWD    || ''; }

/** 한 줄 라벨 (UI/상태 표시용). */
export function sandboxLabel() {
  return sandboxEnabled() ? `wsl:${sandboxDistro()}` : 'host';
}

const baseArgs = () => ['-d', sandboxDistro(), '-u', sandboxUser(), '--'];

/** POSIX 작은따옴표 이스케이프. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 임의 셸 명령을 샌드박스에서 실행할 spawn 스펙 반환.
 * host 모드면 null(호출자가 기존 호스트 경로 사용).
 */
export function wrapShellCommand(command) {
  if (!sandboxEnabled()) return null;
  const cwd = sandboxCwd();
  const inner = cwd ? `cd ${shq(cwd)} && ${command}` : command;
  return { cmd: 'wsl', args: [...baseArgs(), 'bash', '-lc', inner], useShell: false };
}

/**
 * run_code(python/node/shell)를 샌드박스에서 실행할 spawn 스펙 반환.
 * 코드를 별도 argv로 전달 → 따옴표 이스케이프 불필요.
 */
export function wrapCode(language, code) {
  if (!sandboxEnabled()) return null;
  const base = baseArgs();
  if (language === 'python') return { cmd: 'wsl', args: [...base, 'python3', '-c', code], useShell: false };
  if (language === 'node')   return { cmd: 'wsl', args: [...base, 'node', '-e', code], useShell: false };
  if (language === 'shell')  return { cmd: 'wsl', args: [...base, 'bash', '-c', code], useShell: false };
  return null; // 미지원 언어 → 호출자가 처리
}

/**
 * 샌드박스 배포판이 실제로 동작하는지 확인(빠른 동기 점검).
 * 반환: { ok, distro, error? }
 */
export function checkSandbox() {
  if (!sandboxEnabled()) return { ok: true, distro: 'host' };
  try {
    const r = spawnSync('wsl', [...baseArgs(), 'true'], { timeout: 8000, windowsHide: true });
    if (r.status === 0) return { ok: true, distro: sandboxDistro() };
    return { ok: false, distro: sandboxDistro(), error: (r.stderr?.toString() || `exit ${r.status}`).trim() };
  } catch (err) {
    return { ok: false, distro: sandboxDistro(), error: err.message };
  }
}
