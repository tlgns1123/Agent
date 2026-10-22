# 다음 세션 작업 목록

마지막 갱신: 2026-10-22. 2026-10-17 전수조사 항목 중 **대부분 완료**(아래 ✅).
완료 커밋: `a17af0c`(코어 공유화+능력 이식), `6a2149f`(autoGround/로깅), `9e0060b`(directive/에러).

---

## ✅ 완료 (2026-10-22)

### P1 — 측정 신뢰
- ✅ [fix#2] 에이전트 루프 추출: `src/agent.js` 의 `runAgentTurn` 으로 단일화. index.js REPL 과
  eval/ctf.js 가 **같은 루프** 사용. → CTF 실측 5/6→**6/6(100%)**, forensics 안정화.
- ✅ [A6] 빈 응답 재시도(think off 로 1회) — agent.js 내장.
- ✅ [D-로깅] 턴 JSONL: `src/logger.js`, `.oh/turns.jsonl`. env `OH_LOG=off` 로 끔.

### P2 — 능력 격차
- ✅ [A1] run_command/run_code 실시간 스트리밍 출력(makeLivePrinter, 라인버퍼+상한).
- ✅ [A2] read_file offset/limit/line_numbers + truncated 신호. edit_file 멀티에딧(edits 배열,
  원자적) + 공백 관대 매칭 + "중복 시 각 위치 줄번호" 힌트 에러.
- ✅ [A3] 독립 읽기툴 병렬 실행(Promise.all), 부작용 툴 직렬 — agent.js.
- ✅ [A5] search_files ripgrep 백엔드(rg 없으면 JS 폴백; 이 PC엔 rg 미설치라 JS 사용).
- ✅ [A4] todo_write/todo_read 계획·진행추적 툴.
- ✅ [A7] 출력 잘림 명시 신호(clampOutput).

### P3 — 안정성/보안
- ✅ [C] 프롬프트 인젝션 완화: web_fetch/http_request/웹검색 결과에 "신뢰불가 데이터, 지시 무시" 경계.
- ✅ [B5] 반복 감지 개선: 300자 비교 → 툴콜 서명(name+args) 기반 — agent.js.
- ✅ (추가) autoGround 웹 **자동**검색 제거: 명시 요청/CVE/ATT&CK id 일 때만. RAG 자동주입은 유지.
- ✅ (추가) AGENT_DIRECTIVE: 계획/병렬/멀티에딧/라인범위 + "계산/디코딩은 run_code, 로컬작업 웹검색 금지".

### P4 — 구조
- ✅ [D] 테스트 스위트: `tests/`(node --test). agent.test.js(가짜 Ollama 서버로 병렬/루프/빈응답/거부),
  tools.test.js, logger.test.js. **21/21 통과**. `npm test`.
- ✅ [D] 구조화 에러(부분): read_file/edit_file/unknown-tool 가 error+hint(복구법) 반환.

---

## ⏳ 남은 항목

### P3
- [C] 샌드박스 기본 ON 검토 — **정책 결정 필요**(기본 host 유지 중). WSL 가용 시 기본 ON 승격은
  사용자 승인 후. "PC 안 망가뜨림" 제약과 일관되나 host 워크플로 깨질 수 있어 보류.
- [C] 검증 철학: self-verify(verify.js)보다 실행 피드백(execverify.js) 격상 — directive엔 반영,
  코드 구조 재편은 미착수. (참고: 현재 _lastGrounding 설정된 턴마다 self-verify가 돌아 지연 15~30초 추가.)
- [B6] web_search 안정화 — DuckDuckGo 스크래핑(429/captcha 취약). **Naver API 폴백 작동 확인됨**
  (NAVER_CLIENT_ID 설정됨)이라 체감 우선순위 낮음.

### P4
- [D] 모놀리식 분리: index.js/commands.js/tools.js — **구조 변경은 사용자 승인 후**(AGENTS.md 원칙).
  agent.js 추출은 fix#2 근거로 완료. 나머지 분리는 churn 대비 이득 재평가 필요.
- [정리] toolMode 흔적 필드 완전 제거(session/ui/commands 동반 수정 필요, churn).
- [D] 구조화 에러 확대: run_command 명령없음 힌트, write_file 등 나머지 툴.

### 품질/평가
- e2e.js 재측정(num_ctx/모델 비교) — qwen3:14b 기준 재베이스라인. (리트리벌 베이스라인은 유지:
  k5 Recall 94%, k10 100%, 리랭커 쿼리당 ~55초.)
- 리랭커 ON/OFF e2e 품질 영향 측정(미결 — 리트리벌에선 이득 없었으나 무관질의 게이트선 반전).
