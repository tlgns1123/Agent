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

## ✅ 추가 완료 (2026-10-22 2차)
- [C] 샌드박스: 기본 host 유지(사용자 결정) + **`/sandbox on|off|status` 런타임 토글**(env 불필요).
- [C] 검증 철학: self-verify **기본 off**로 격하(매턴 15~30초 지연 제거) + **`/verify` 토글**(self/exec).
  실행 피드백을 1차 신뢰근거로. 시작/설정/help 메시지도 명령 안내로 갱신.
- [B6] web_search: **Bing HTML 폴백 추가**(Naver→DDG→Bing). 키 불필요, DDG captcha/429 대비.
- [D] 구조화 에러: run_command/run_code 명령없음·타임아웃 **hint** 반환. unknown-tool 유사툴 제안.
- (환경) **호스트 셸 cmd→PowerShell 전환**(사용자 결정): resolvePwsh(pwsh→powershell.exe→cmd폴백),
  UTF-8 BOM+OutputEncoding 으로 한글 mojibake 완전 해결, 경로 C:\ 일관, 사용자 실제 셸과 일치.
  Linux/bash 는 /sandbox on(WSL) 담당. 시스템프롬프트/툴설명에 "호스트=PowerShell" 고지. python PYTHONUTF8 유지.

## ⏳ 남은 항목

### 보류(사유 명시 — 사용자 판단 필요)
- [D] **모놀리식 분리**(index/commands/tools) — capability 이득 0, 대규모 churn + 리그레션 리스크.
  AGENTS.md 원칙상 명시 동의 필요. agent.js 추출(fix#2)만 완료. **권장: 필요해질 때 파일별로 점진 분리.**
- [정리] **toolMode 흔적 필드 제거** — session 직렬화/ui/commands 동반 수정 churn, 기능 영향 0. 보류.

### 품질/평가
- 리랭커 ON/OFF e2e 품질 영향 측정(미결 — 리트리벌에선 이득 없었으나 무관질의 게이트선 반전).
- (qwen3 e2e 베이스라인은 2026-10-22 측정 — project_last_session 참고.)
