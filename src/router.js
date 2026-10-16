/**
 * OH 모델 라우터 — 턴 의도에 따라 빠른 모델(Q&A)과 에이전트 모델(툴/코딩)을 전환.
 *
 * 배경(2026-10-17 실측): WRN-7B는 툴콜 0/6(XML·네이티브 둘 다 무호출) = 근본 한계.
 * Qwen3-14B는 네이티브 4/6. 따라서 "툴이 필요한 작업(바이브코딩·리버싱·파일조작)"은
 * 에이전트 모델로 보내야 실제로 동작한다. 빠른 Q&A는 autoGround가 근거를 미리 주입하므로
 * 툴콜이 필요 없어 빠른 모델이 적합.
 *
 * env:
 *   OH_ROUTER         on|off (기본 on)
 *   OH_MODEL_AGENT    에이전트(툴/코딩) 모델 (기본 qwen3:14b) — 미설치면 라우터 자동 비활성
 *   OH_AGENT_ITERS    에이전트 턴 최대 반복(기본 10)
 */

export function routerEnabled() {
  return (process.env.OH_ROUTER ?? 'on').toLowerCase() !== 'off';
}

export function agentModelName() {
  return process.env.OH_MODEL_AGENT || 'qwen3:14b';
}

export function agentIters() {
  return Math.max(3, parseInt(process.env.OH_AGENT_ITERS ?? '10', 10) || 10);
}

// 스티키 모드: 에이전트 모델에 있을 때, 비에이전트 턴이 N회 연속돼야 빠른 모델로 되돌림.
// 모델 스왑(VRAM 리로드)이 비싸므로 코딩세션 중 끼어든 1회성 질문에 반사적으로 안 내려가게 한다.
export function routerSticky() {
  return (process.env.OH_ROUTER_STICKY ?? 'on').toLowerCase() !== 'off';
}
export function stickyN() {
  return Math.max(1, parseInt(process.env.OH_ROUTER_STICKY_N ?? '2', 10) || 2);
}

// 행동(툴 필요) 의도 — 작성/실행/수정/테스트/리버싱/파일조작 등.
const ACTION_RE = new RegExp([
  '작성', '만들', '생성', '구현', '짜줘', '짜봐', '수정', '고쳐', '고치', '리팩', '바꿔',
  '추가해', '삭제', '제거', '옮겨', '이동해',
  '실행', '돌려', '테스트', '빌드', '컴파일', '설치', '디버그', '커밋', '푸시', '배포',
  '리버싱', '디스어셈', '역어셈', '언패킹', '분석해줘', '스캔', '익스플로잇', '페이로드',
  '스크립트', 'PoC', '자동화',
  '파일.{0,4}(만|생성|수정|읽|저장|열)',
  'write', 'create', 'run', 'execute', 'build', 'compile', 'test', 'fix', 'refactor',
  'implement', 'script', 'revers', 'disassembl', 'exploit', 'payload', 'debug', 'deploy',
].join('|'), 'i');

// 툴이 필요한 보안 조회(라우터가 에이전트로 보내는 편이 나은 케이스).
const TOOL_QUERY_RE = /(패키지.{0,6}(버전|취약)|버전.{0,6}취약|dependency|gtfobins|suid.{0,6}(권한|상승)|lolbas)/i;

/** 이 턴이 에이전트(툴/코딩) 모델을 필요로 하는가. */
export function needsAgent(text) {
  const t = (text || '').trim();
  if (t.length < 2) return false;
  return ACTION_RE.test(t) || TOOL_QUERY_RE.test(t);
}

/**
 * 에이전트 턴에 시스템 프롬프트에 덧붙일 "행동 지시문".
 * 바이브코딩 행동(복붙 안내 금지, 직접 파일생성·실행·수정·재실행)을 강제한다.
 */
export const AGENT_DIRECTIVE = `## 에이전트 행동 규칙 (툴 우선 — 반드시 준수)
너는 터미널에서 **직접 행동하는** 코딩/보안 에이전트다. 사용자에게 "이 코드를 복사해서 붙여넣으세요"라고 안내하지 말 것. 네가 직접 도구로 수행한다.

- 파일을 만들거나 고칠 때: write_file / edit_file 툴을 호출해 **직접** 작성한다.
- 절대 결과를 상상해서 쓰지 말 것. 도구를 호출하고 **실제 결과**를 받은 뒤 진행한다.

### 실행·검증 (중요: "매 수정마다"가 아니라 "의미 있는 단위마다")
- 관련된 수정들을 **한 덩어리로 묶어 완성한 뒤**, 그때 run_command / run_code 로 한 번 검증한다. 한 줄 고칠 때마다 반사적으로 돌리지 말 것(시간·부작용 낭비).
- 실행은 **검증 가치가 있을 때만**: 테스트·빌드·스크립트가 돌아갈 상태가 됐을 때. 문서·주석·단순 리네이밍은 실행하지 않는다.
- 검증에서 에러가 나면: read_file로 원인 확인 → edit_file로 수정 → **다시 검증**. 이 루프는 "작업 단위"로 반복하되, 같은 수정을 무의미하게 재실행하지 않는다.
- **부작용 주의**: 네트워크 전송·파일 삭제·외부 공격 행위 등 되돌리기 어렵거나 실제 영향이 있는 코드는 함부로 "테스트 삼아" 실행하지 말 것. 이런 코드는 **반드시 격리 샌드박스에서만** 실행하고, 애매하면 사용자에게 먼저 확인한다.

### 도구 라우팅
- 바이너리 리버싱: reverse_import로 샌드박스에 넣고 reverse_overview→reverse_strings/disasm/r2 순으로 분석.
- 패키지 버전·취약점: dependency_lookup. GTFOBins/SUID 권한상승: gtfobins_lookup.
- 작업이 끝날 때까지 도구를 연쇄 호출한다. 한 번에 안 되면 단계를 나눠 계속한다.`;
