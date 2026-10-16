# 다음 세션 작업 목록 (전수조사 미완 항목)

2026-10-17 전수조사(Claude Code류 에이전트 CLI 대비)에서 식별했으나 **아직 수정 안 한** 항목.
완료분은 git 로그 참고: `f2a5cad`(실행 안전), `ef1cd44`(native 전용화), 기본모델 qwen3 전환.

우선순위: **측정 신뢰 → 능력 격차 → 정리** 순. 번호는 원래 감사 리스트의 ID.

---

## P1 — 측정 신뢰 (이게 서야 나머지 판단이 안 오염됨)

### [fix#2] 에이전트 루프 추출 + eval 공유
- **문제**: 턴 루프가 `src/index.js`(프로덕션)와 `eval/ctf.js`·`eval/e2e.js`(평가)에 **두 벌**. eval이 프로덕션보다 덜 견고해 실제 능력을 과소측정(forensics "빈 답변" 사례).
- **할 일**: `runAgentTurn(state, …)` 코어를 별도 모듈로 추출 → index.js REPL과 eval 하네스가 **같은 코드** 사용.
- **검증**: ctf.js를 추출된 루프로 재배선 후 성공률 재측정(루프 통일 전후 비교).

### [A6] 빈 응답 재시도 (native)
- **문제**: native 모드에서 모델이 "빈 응답 + 툴콜 없음"이면 그냥 종료(재시도 없음). 과거 XML 모드엔 있던 재시도가 native엔 없음. `src/index.js` 네이티브 블록 뒤 "Plain response — done" 직전.
- **할 일**: `fullContent.trim()`이 비고 `nativeToolCalls`도 없으면 1회 재시도(사고 budget 초과 감지). 무한루프 방지 카운터 포함.
- **주의**: 측정상 qwen3는 0/53으로 안 터졌으나, 긴 컨텍스트/high effort에선 발생 가능.

### [D-로깅] 턴 로깅 (JSONL)
- **문제**: 턴별 기록이 전무 → 실패 디버깅마다 진단 스크립트를 새로 짜야 함(이번 세션에 실제로 그랬음).
- **할 일**: 턴마다 `{ts, model, prompt, content, tool_calls, tool_results, elapsed}` 한 줄씩 JSONL로. 끄기 가능한 env 플래그.

---

## P2 — 능력 격차 (체감 품질 직결)

### [A1] 툴 실행 출력 스트리밍
- **문제**: `src/tools.js` `spawnProcess`가 close까지 버퍼링 → 긴 빌드/스캔/`run_command`가 끝날 때까지 깜깜이.
- **할 일**: chunk 콜백으로 stdout/stderr 실시간 출력(ollama.js 스트림 패턴 재사용).

### [A2] read_file 라인번호 + offset/limit, edit_file 견고화
- **문제**: `toolReadFile`가 content 전체 반환(큰 파일 = 컨텍스트 폭발), 라인번호 없음. `edit_file`이 exact-string match라 고유문자열 못 잡으면 실패.
- **할 일**: read_file에 라인번호 부여 + offset/limit 파라미터. edit_file을 라인기반 or 더 관대한 매칭으로.

### [A3] 독립 툴콜 병렬 실행
- **문제**: `src/index.js` 네이티브 루프가 `for (const tc of ...)` 순차.
- **할 일**: 부작용 없는 읽기 툴(read/list/search/find/rag)은 `Promise.all` 병렬, write/run/delete/http는 직렬 유지.

### [A5] search_files / find_files → ripgrep 백엔드
- **문제**: 자체 JS 정규식 워커(500KB 초과 스킵, 바이너리 처리 조잡)라 느리고 약함.
- **할 일**: ripgrep(rg) 있으면 그걸로 위임, 없으면 현재 구현 폴백.

### [A4] 계획/할일 추적 툴
- **문제**: 멀티스텝 작업에서 진행 추적 수단 없음(반복감지 300자 비교로 땜질 중).
- **할 일**: TodoWrite류 경량 툴 추가(선택적).

### [A7] 출력 잘림 신호
- **문제**: `.slice(0, 10_000)` 등으로 잘려도 모델이 전체로 오인.
- **할 일**: 잘렸으면 `"...[N chars truncated]"` 명시.

---

## P3 — 안정성/보안 대안

### [C] 샌드박스 기본 ON 검토
- **문제**: 보안툴인데 기본이 host(무격리 PC 직접 실행). `OH_SANDBOX=host`가 기본.
- **할 일**: WSL 샌드박스 사용 가능하면 기본 ON으로 승격 검토("PC 안 망가뜨림" 제약과 일관).

### [C] 프롬프트 인젝션 완화
- **문제**: `web_fetch`/`http_request`/`web_search` 출력이 그대로 모델 컨텍스트로 유입 → 인젝션 벡터.
- **할 일**: 외부 콘텐츠를 인용부호/출처로 래핑하고 "명령처럼 보이는 지시 무시" 경계 명시.

### [C] 검증 철학: self-verify보다 실행 피드백
- **문제**: `src/verify.js` 자기비판은 7~14B에서 천장 낮음.
- **할 일**: `execverify.js` 쪽(샌드박스 실제 실행 결과)을 1차 신뢰근거로 격상.

### [B5] 반복 감지 개선
- **문제**: content 앞 300자 비교(`recentContents`)는 증상 억제.
- **할 일**: 루프 추출(fix#2) 이후 툴콜 기반 진행 감지로 대체.

### [B6] web_search 안정화
- **문제**: DuckDuckGo HTML 스크래핑(429/captcha 취약).
- **할 일**: 공식 검색 API 경로 보강(Naver API 폴백은 이미 있음, 키 필요).

---

## P4 — 구조 정리

- **[D] 테스트 스위트 신설**: `tools.js`부터. 최소 세트(run_code 멀티라인, edit_file 매칭, search glob). package.json `test` 스크립트 추가.
- **[D] 모놀리식 분리**: `index.js`(~1360)/`commands.js`(~1590)/`tools.js`(~1820) 책임 분리.
- **[D] 구조화 에러**: `executeTool`이 `{error: msg}` 문자열만 반환 → 복구 힌트(예: "파일 없음 → list_directory 먼저") 구조화해 모델 자가복구율↑.
- **[정리] toolMode 흔적 필드**: native 전용화 후 `toolMode`는 session/ui 표시용으로만 남음. 완전 제거하려면 session.js·ui.js·commands.js 동반 수정 필요(churn 있어 보류).
