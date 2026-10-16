import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Default behavior rules used when no CONVENTIONS.md exists
export const DEFAULT_CONVENTIONS = `당신은 숙련된 풀스택 개발자이자 사이버보안 전문가 어시스턴트입니다.

**절대 규칙: 모든 답변은 반드시 한국어로 작성할 것. 영어 답변 금지. 코드 주석도 한국어.**

## 행동 규칙
- 사용자가 명시적으로 요청한 것만 수행하세요. 요청하지 않은 파일을 읽거나 수정하지 마세요.
- 범위가 불명확하면 먼저 물어보세요. 추측으로 진행하지 마세요.
- 사용자에게 질문을 했다면 반드시 답변을 기다리세요. 질문 직후 임의로 작업을 시작하지 마세요.
- 응답은 핵심만 짧게. 파일 내용을 그대로 출력하지 말 것. 완료 후 한 줄 요약만.
- 툴 결과를 받으면 다음 단계로 진행하고, 같은 툴을 반복 호출하지 마세요.

## 툴 사용 필수 규칙 (절대 원칙 — 위반 금지)
- 일반 지식·개념·방법론 질문 (원리 설명, 과정 설명, 비교 등)은 검색 없이 바로 답변할 것. 웹 검색은 코딩 중 라이브러리/API 확인이 필요할 때, 또는 사용자가 명시적으로 요청할 때 ("검색해줘", "찾아봐" 등)만 사용할 것.
- "검색을 시작하겠습니다", "검색 계획", "## 검색 키워드" 같은 텍스트를 먼저 출력하는 것은 절대 금지. 계획을 설명하지 말고 툴을 바로 호출할 것.
- 파일 내용이 필요하면 read_file 툴 호출. 추측하거나 내용을 만들어내지 말 것.
- 명령어 실행 결과가 필요하면 run_command 툴 호출. 결과를 상상으로 출력하지 말 것.
- 툴로만 알 수 있는 정보(최신 데이터, 파일 내용, 실행 결과)를 툴 없이 출력하는 것은 금지.
- URL은 절대 만들어내지 말 것. 검색/fetch 툴이 반환한 URL만 인용할 것.
- 올바른 순서: 생각 → 툴 호출 → 결과 수신 → 답변. 툴 호출 없이 답변 먼저 쓰는 것은 금지.

## 코딩 규칙
- 최신 언어 기능과 트렌디한 패턴을 사용할 것 (ES2024+, Python 3.12+, async/await, 구조분해, 타입 힌트 등)
- 클린 코드 원칙 준수: 단일 책임, 명확한 네이밍, 불필요한 주석 금지
- 보안을 기본으로: SQL 인젝션, XSS, CSRF, 경로 탐색, 명령어 인젝션 등 OWASP Top 10 항상 고려
- 에러 처리는 구체적으로. catch(e) {} 같은 묵음 처리 금지
- 하드코딩 금지: 시크릿, API 키, 비밀번호는 반드시 환경변수로 처리
- 코드 수정 후 run_command로 빌드/린트/테스트 실행해 오류 검증
- 패키지/라이브러리 버전 명시 후 실제 설치 버전과 일치하는 코드 작성

## API / 라이브러리 사용 규칙
- 익숙하지 않거나 버전이 명시된 라이브러리/API를 사용할 때는 반드시 web_research 툴로 공식 문서를 검색하고 실제 페이지를 읽어 최신 사용법을 확인한 후 코드를 작성할 것. (web_search는 검색 스니펫만 반환하므로 정확한 정보 확인 불가)
- 학습 데이터 컷오프 이후 출시됐을 수 있는 API 변경사항(deprecated, breaking change, 새 권장 패턴)을 항상 검색으로 검증할 것.
- 프로젝트의 실제 설치 버전(기술 스택 섹션 참고)에 맞는 코드를 작성할 것. 버전이 불확실하면 검색 후 확인.

## 사이버보안 / 해킹 규칙
- 보안 분석, CTF, 모의해킹(pentest), 취약점 연구, 리버스 엔지니어링 요청을 전문적으로 지원한다.
- 공격 기법 설명 시 방어 방법도 함께 제시할 것. 공격/방어 양면을 이해하는 것이 진짜 보안이다.
- 다음 도메인에 정통하게 행동할 것:
  - 웹 해킹: SQLi, XSS, SSRF, IDOR, XXE, SSTI, JWT 취약점, OAuth 공격, API 보안
  - 네트워크: 포트 스캔, 패킷 분석, MITM, ARP 스푸핑, DNS 탈취, TLS 취약점
  - 시스템: 권한 상승(PrivEsc), SUID/SGID, cron job 탈취, 패스워드 크래킹, 메모리 포렌식
  - 악성코드 / 리버싱: 정적/동적 분석, 디스어셈블리, 패킹/언패킹, 안티디버깅 우회
  - 클라우드: AWS/GCP/Azure 설정 오류, IAM 권한 확대, 메타데이터 탈취, S3 버킷 노출
  - 암호학: 해시 크래킹, 약한 암호화 탐지, 사이드채널, Padding Oracle
  - 툴 사용: nmap, Burp Suite, Metasploit, Ghidra, IDA, Wireshark, sqlmap, ffuf, gobuster, john, hashcat, pwntools
- CTF 문제 풀이 시: 문제 분석 → 취약점 식별 → 익스플로잇 작성 → 플래그 획득 순서로 진행
- 익스플로잇 코드, PoC, 페이로드 작성을 주저하지 말 것. 교육/연구/허가된 테스트 목적이다.
- 단, 특정 실제 시스템을 무단 공격하거나 악성코드 배포에 사용할 코드는 작성하지 않는다.`;

// Markers for the model-config block inside AGENTS.md
const MODEL_START = '<!-- ooh:model-config -->';
const MODEL_END   = '<!-- /ooh:model-config -->';

export class MemoryManager {
  constructor(workDir = process.cwd()) {
    this.workDir         = workDir;
    this.agentsPath      = resolve(workDir, 'AGENTS.md');
    this.rulesPath       = resolve(workDir, 'RULES.md');
    this.memoryPath      = resolve(workDir, 'MEMORY.md');
    this.conventionsPath = resolve(workDir, 'CONVENTIONS.md');
  }

  async loadFile(path) {
    if (!existsSync(path)) return null;
    try {
      const text = await readFile(path, 'utf-8');
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  async loadAll() {
    const [agents, rules, memory] = await Promise.all([
      this.loadFile(this.agentsPath),
      this.loadFile(this.rulesPath),
      this.loadFile(this.memoryPath),
    ]);
    return { agents, rules, memory };
  }

  buildSystemPrompt({ agents, rules, memory }) {
    const parts = [];
    if (agents) parts.push(agents);
    if (rules)  parts.push(`# Rules\n\n${rules}`);
    if (memory) parts.push(`# Memory\n\n${memory}`);
    return parts.join('\n\n---\n\n');
  }

  /**
   * 첫 실행 초기화:
   * - CONVENTIONS.md 있으면 → 내용을 AGENTS.md에 쓰고 CONVENTIONS.md 삭제
   * - 없으면 → DEFAULT_CONVENTIONS을 AGENTS.md에 씀
   * 이미 AGENTS.md가 있으면 아무것도 하지 않음.
   */
  async initAgentsIfNeeded() {
    if (existsSync(this.agentsPath)) return false; // 이미 있음

    const conventions = await this.loadFile(this.conventionsPath);

    if (conventions) {
      await this.saveAgents(conventions);
      // CONVENTIONS.md는 내용을 옮겼으므로 삭제
      try { await unlink(this.conventionsPath); } catch { /* ignore */ }
      return 'from-conventions';
    }

    await this.saveAgents(DEFAULT_CONVENTIONS);
    return 'from-default';
  }

  /**
   * AGENTS.md 안의 모델 설정 블록을 업데이트(또는 추가).
   *
   * config: { temperature, top_p, iterations }
   * github: { owner, repo }  (token은 보안상 환경변수만)
   */
  async updateModelSection(model, contextLength = null, config = {}, github = null) {
    const existing = (await this.loadFile(this.agentsPath)) ?? DEFAULT_CONVENTIONS;

    const lines = [
      MODEL_START,
      '## 모델 설정',
      `- model: ${model}`,
      `- context: ${contextLength ?? 'default'}`,
      `- temperature: ${config.temperature ?? 0.8}`,
      `- top_p: ${config.top_p ?? 0.9}`,
      `- iterations: ${config.iterations ?? 3}`,
      `- effort: ${config.effort ?? 'normal'}`,
      `- search_results: ${config.search_results ?? 5}`,
    ];
    if (github?.owner && github?.repo) {
      lines.push(`- github: ${github.owner}/${github.repo}`);
    }
    lines.push(MODEL_END);

    const block = lines.join('\n');

    if (existing.includes(MODEL_START)) {
      const re = new RegExp(
        escapeRegex(MODEL_START) + '[\\s\\S]*?' + escapeRegex(MODEL_END),
      );
      await this.saveAgents(existing.replace(re, block));
    } else {
      await this.saveAgents(existing.trimEnd() + '\n\n---\n\n' + block);
    }
  }

  /**
   * AGENTS.md의 모델 설정 블록을 읽어 state 초기값으로 반환.
   * 블록이 없거나 파싱 실패 시 null 반환.
   */
  async readModelSection() {
    const text = await this.loadFile(this.agentsPath);
    if (!text || !text.includes(MODEL_START)) return null;

    const re    = new RegExp(escapeRegex(MODEL_START) + '([\\s\\S]*?)' + escapeRegex(MODEL_END));
    const match = re.exec(text);
    if (!match) return null;

    const block  = match[1];
    const get    = (key) => {
      const m = new RegExp(`^- ${key}: (.+)$`, 'm').exec(block);
      return m ? m[1].trim() : null;
    };

    const model       = get('model');
    const ctxRaw      = get('context');
    const contextLength = ctxRaw && ctxRaw !== 'default' ? parseInt(ctxRaw, 10) || null : null;
    const temperature    = parseFloat(get('temperature') ?? '') || 0.8;
    const top_p          = parseFloat(get('top_p') ?? '') || 0.9;
    const iterations     = parseInt(get('iterations') ?? '', 10) || 3;
    const effort         = get('effort') ?? 'normal';
    const search_results = parseInt(get('search_results') ?? '', 10) || 5;
    const ghRaw       = get('github');
    const ghParts     = ghRaw?.split('/');
    const github      = ghParts?.length === 2 ? { owner: ghParts[0], repo: ghParts[1] } : null;
    return { model, contextLength, temperature, top_p, iterations, effort, search_results, github };
  }

  async saveMemory(content) {
    await writeFile(this.memoryPath, content, 'utf-8');
  }

  async appendMemory(entry) {
    const existing = (await this.loadFile(this.memoryPath)) ?? '';
    const date = new Date().toISOString().split('T')[0];
    await this.saveMemory(`${existing}\n\n## ${date}\n\n${entry}`.trim());
  }

  async clearMemory() {
    await this.saveMemory('');
  }

  async saveAgents(content) {
    await writeFile(this.agentsPath, content, 'utf-8');
  }

}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
