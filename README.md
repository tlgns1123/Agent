# OH — Local AI Agent for Development & Security Research

> 로컬 Ollama 모델 위에서 동작하는 **상용 코딩 에이전트 스타일의 CLI 에이전트**.
> 코드를 읽고·쓰고·실행하고, 권위 있는 보안 출처를 직접 조회하며, 로컬 RAG로 근거를 보강한다.
> 클라우드 API 없이 **완전 오프라인·프라이버시 보존** 환경에서 돌아간다.

<p>
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-23%2F23%20passing-brightgreen">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Ollama%20(local)-000000">
  <img alt="Lang" src="https://img.shields.io/badge/lang-JavaScript%20(ESM)-f7df1e?logo=javascript&logoColor=black">
</p>

---

## 한눈에 보기

OH는 "로컬 LLM도 상용 코딩 에이전트처럼 쓸 수 있는가?"라는 질문에서 출발한 프로젝트다.
직접 설계한 **에이전트 루프**, **검색 증강 생성(RAG) 파이프라인**, **출력 품질 자가검증 루프**를 결합해,
외부 API에 의존하지 않고도 코드 작업과 보안 연구를 수행한다.

- **개발 관점** — 멀티툴 병렬 실행·스트리밍·원자적 멀티에딧·계획(todo) 추적·테스트 스위트를 갖춘 에이전트 하네스
- **보안 관점** — NVD/CVE, MITRE ATT&CK, KEV, ExploitDB, GTFOBins 등 **1차 권위 출처 커넥터** + 로컬 보안 지식 RAG

> ⚠️ 본 도구는 **합법적이고 허가된 범위**의 보안 연구·CTF·방어 목적으로만 사용한다. 자세한 내용은 [보안·책임 고지](#보안책임-고지) 참고.

---

## 왜 만들었나

상용 코딩 에이전트는 강력하지만 (1) 코드·데이터가 외부로 나가고 (2) 토큰 비용이 들며 (3) 특정 도메인 지식이 얕다.
OH는 이 세 가지를 로컬 환경에서 해결하는 것을 목표로 한다.

| 문제 | OH의 접근 |
|---|---|
| 데이터 외부 유출 | Ollama 로컬 모델 + 로컬 벡터스토어 → 네트워크 없이 동작 |
| 토큰 비용 | 자체 호스팅으로 추론 비용 $0 |
| 도메인 지식 부족 | 권위 출처 실시간 커넥터 + 보안 지식 RAG 적재 |
| 로컬 모델의 낮은 신뢰도 | 교사 루프(teacher loop) + 코드 게이트(L1/L2) + eval 하네스로 출력 검증 |

---

## 주요 기능

### 에이전트 코어 (`src/agent.js`)
- **단일 턴 루프** — REPL과 평가(eval) 하네스가 동일한 루프를 공유해 측정 신뢰성 확보
- **병렬 툴 실행** — 부작용 없는 읽기 툴은 `Promise.all`로 병렬, 쓰기/실행 툴은 직렬로 안전하게
- **실시간 스트리밍** — 토큰 단위 출력 및 `run_command`/`run_code` 라인 버퍼 스트리밍
- **반복 감지** — 툴콜 서명(name+args) 기반 루프 차단으로 무한 반복 방지
- **프롬프트 인젝션 완화** — 웹 조회 결과를 "신뢰 불가 데이터" 경계로 격리

### 파일·실행 툴 (27종)
`read_file`(offset/limit/라인번호) · `edit_file`(원자적 멀티에딧, 공백 관대 매칭) · `write_file` ·
`search_files`(ripgrep 백엔드, 폴백 JS) · `find_files` · `run_command` · `run_code` ·
디렉터리/복사/이동/삭제 · `todo_write`/`todo_read`(계획·진행 추적) · 샌드박스 스테이징

### 보안 지식 커넥터 (`src/connectors.js`)
1차 권위 출처를 코드에서 직접 조회한다. 2차 블로그·요약글은 배제한다.

| 커넥터 | 출처 | 용도 |
|---|---|---|
| `cve_lookup` | NVD / CVE | 취약점 상세·CVSS |
| `attack_lookup` | MITRE ATT&CK | 전술·기법 매핑 |
| `exploit_search` | ExploitDB | 공개 익스플로잇/PoC |
| `gtfobins_lookup` | GTFOBins | Unix 바이너리 악용/권한상승 |
| `lolbas_lookup` | LOLBAS | Windows LOLBins |
| `dependency_lookup` | OSV / GHSA | 의존성 취약점 |
| — | KEV / EPSS | 악용 우선순위 판단 |

### 검색 증강 생성 — RAG (`src/rag.js`)
- **로컬 임베딩** — `@huggingface/transformers`로 온디바이스 임베딩 (외부 호출 없음)
- **벡터스토어** — LanceDB, 메타데이터는 `better-sqlite3`
- **freshness 전략** — 휘발성 정보(패키지 버전)는 라이브 소스, 안정 정보(CVE 등)는 캐시

### 출력 품질 검증
- **교사 루프** (`src/teacher.js`) — 논리 버그를 외부 교사 모델이 교정·적립·재주입
- **코드 게이트** (`src/codegate.js`) — L1(정적)·L2(실행) 2단계 코드 품질 검사
- **실행 검증** (`src/execverify.js`) — 실행 피드백을 1차 신뢰 근거로 사용
- **eval 하네스** (`eval/`) — 리트리벌/E2E/CTF 정량 평가. 현재 **CTF 6/6, 단위 테스트 23/23 통과**

---

## 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│                        OH CLI (REPL)                           │
│  src/index.js · commands.js · ui.js · session.js               │
└───────────────┬───────────────────────────┬──────────────────┘
                │                           │
        ┌───────▼────────┐          ┌───────▼────────┐
        │  Agent Loop     │          │   Slash cmds    │
        │  src/agent.js   │          │   (30종)        │
        │  병렬툴·스트리밍 │          │  /rag /cve ...  │
        └───────┬────────┘          └────────────────┘
                │
   ┌────────────┼────────────┬───────────────┬──────────────┐
   ▼            ▼            ▼               ▼              ▼
┌──────┐   ┌─────────┐  ┌──────────┐   ┌──────────┐   ┌─────────┐
│ Tools │   │   RAG    │  │Connectors│   │ Verify    │   │ Ollama   │
│tools. │   │ rag.js   │  │connectors│   │ teacher/  │   │ ollama.js│
│ js    │   │ (Lance+  │  │ (NVD/CVE/│   │ codegate/ │   │ (로컬 LLM│
│ 27종  │   │ sqlite)  │  │ ATT&CK..)│   │ execverify│   │  추론)   │
└──────┘   └─────────┘  └──────────┘   └──────────┘   └─────────┘
```

**데이터 흐름:** 사용자 입력 → 에이전트 루프 → (RAG 근거 주입 + 커넥터 조회) → 툴 실행 → 품질 검증 → 응답

---

## 기술 스택

| 구분 | 사용 기술 |
|---|---|
| 런타임 | Node.js ≥ 18 (v22에서 검증), ESM |
| LLM | Ollama 로컬 추론 (기본: Qwen3-Coder-30B-A3B 계열, 교체 가능) |
| 임베딩 | `@huggingface/transformers` (온디바이스) |
| 벡터 DB | `@lancedb/lancedb` |
| 메타데이터 | `better-sqlite3` |
| CLI UI | `chalk` |
| 테스트 | `node --test` (내장 테스트 러너) |

---

## 빠른 시작

### 사전 요구사항
- [Node.js](https://nodejs.org) ≥ 18
- [Ollama](https://ollama.com) 설치 및 모델 pull

```bash
# 1) 저장소 클론
git clone https://github.com/tlgns1123/Agent.git
cd Agent

# 2) 의존성 설치
npm install

# 3) Ollama 모델 준비 (예시 — 환경에 맞는 코딩 모델로 교체 가능)
ollama pull qwen3-coder:30b

# 4) 실행 (OH 미기동 시 ollama serve 자동 기동)
npm start
#   또는 전역 링크 후:  ooh
```

### 환경 변수 (선택)
`.env` 또는 셸 환경에 설정 (저장소에는 포함되지 않음):

```bash
OH_LOG=off                 # 턴 JSONL 로깅 비활성화
GITHUB_OWNER=...           # /git 기능용 (선택)
GITHUB_REPO=...
GITHUB_TOKEN=...           # 절대 커밋 금지
```

---

## 사용 예시

```text
> CVE-2024-3094 분석해줘
  → cve_lookup(NVD) 조회 → CVSS·영향·KEV 여부 → 방어 권고까지 정리

> 이 디렉터리 전체에서 하드코딩된 시크릿 찾아줘
  → search_files(ripgrep) 병렬 스캔 → 패턴 매칭 → 위치별 보고

> src/auth.js 의 JWT 검증 로직 리뷰하고 고쳐줘
  → read_file → 취약점 식별 → edit_file(멀티에딧) → run_code 검증
```

### 슬래시 명령 (일부)
`/rag` 지식 검색·적재 · `/model` 모델 전환 · `/sandbox` 실행 격리 토글 ·
`/verify` 검증 토글 · `/todo` 계획 보기 · `/tools` 툴 목록 · `/memory` 메모리 ·
`/git` · `/diff` · `/lint` · `/check` · `/session` · `/context` · `/help`

---

## 프로젝트 구조

```
src/
  index.js        진입점 · REPL
  agent.js        에이전트 턴 루프 (코어)
  commands.js     슬래시 명령 처리
  tools.js        27종 툴 정의/실행
  connectors.js   보안 출처 커넥터 (NVD/ATT&CK/ExploitDB/…)
  rag.js          RAG 파이프라인 (Lance + sqlite)
  teacher.js      교사 루프 (논리버그 교정)
  codegate.js     코드 품질 게이트 (L1/L2)
  execverify.js   실행 기반 검증
  ollama.js       Ollama 클라이언트
  router.js       의도 라우팅
  sandbox.js      실행 격리
  memory.js       영속 메모리
  ...
eval/             리트리벌·E2E·CTF 평가 하네스
tests/            단위 테스트 (node --test)
knowledge/        보안 코드 템플릿 코퍼스
plugins/          확장 플러그인 (예: reversing)
```

---

## 품질·검증

```bash
npm test          # 단위 테스트 (현재 23/23 통과)
npm run eval      # 리트리벌·E2E·CTF 평가
```

- **단위 테스트** — 가짜 Ollama 서버로 병렬 실행·루프 차단·빈 응답 재시도·거부 처리 검증
- **CTF eval** — 실제 과제 기반 6/6 통과 (base64 디코딩, 패스워드 크래킹, 포렌식 등)
- **구조화 에러** — 툴 실패 시 복구 힌트(hint)를 반환해 에이전트가 스스로 교정

---

## 설계 의도 (하이라이트)

- **측정 신뢰성** — REPL과 평가가 같은 루프를 공유하도록 리팩터링해, "데모에선 되는데 측정은 안 되는" 괴리 제거
- **로컬 모델의 한계 보완** — raw 추론 능력을 올리는 대신 스캐폴딩(검증·RAG·커넥터)으로 체감 품질을 끌어올리는 전략
- **데이터 위생** — 오염된 지식(수만 청크 규모 자동 생성 덤프)을 탐지·제거하고 벡터스토어를 재구축·압축한 운영 경험

---

## 보안·책임 고지

본 프로젝트는 **레드팀 실습, 버그바운티, 보안 연구, CTF, 방어 목적**의 합법적이고 허가된 테스트 환경을 전제로 한다.
공격 기법은 항상 **방어·개선 방안과 함께** 다룬다.

- 특정 실제 시스템에 대한 무단 공격, 악성코드 배포 목적의 사용을 지원하지 않는다.
- 사용자는 자신이 **권한을 보유한 대상**에 대해서만 본 도구를 사용할 책임이 있다.
- 모든 보안 정보는 공식 문서·CVE/NVD/MITRE·OWASP 등 검증된 1차 출처를 우선한다.

---

## 라이선스

개인 포트폴리오/연구용 프로젝트. 별도 라이선스 명시 전까지 모든 권리는 저작자에게 있다.
