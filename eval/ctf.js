// OH Phase5 — 미니 CTF 성공률 평가. 에이전트가 툴로 플래그를 끝까지 찾아내는가(종단간 문제해결).
// 각 챌린지는 결정적 플래그가 있고, 에이전트 최종답변에 그 플래그가 있으면 성공.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { TOOL_DEFINITIONS, executeTool } from '../src/tools.js';
import { PluginManager } from '../src/plugins.js';
import { BackupManager } from '../src/backup.js';
import { AGENT_DIRECTIVE, agentModelName } from '../src/router.js';
import { runAgentTurn, toOllamaTool } from '../src/agent.js';

const rot13 = (s) => s.replace(/[a-zA-Z]/g, (c) => {
  const b = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
});
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const md5 = (s) => createHash('md5').update(s).digest('hex');

// ── 챌린지 정의: setup(dir)으로 파일 생성, prompt는 에이전트 지시, flag는 정답 ──
const CHALLENGES = [
  {
    id: 'base64', flag: 'FLAG{base64_is_not_encryption}',
    setup: (d) => writeFileSync(join(d, 'secret.txt'), b64('FLAG{base64_is_not_encryption}')),
    prompt: '현재 폴더 secret.txt 에 base64로 인코딩된 플래그가 있다. 디코드해서 FLAG{...} 를 찾아 보고하라.',
  },
  {
    id: 'rot13', flag: 'FLAG{rot13_wheel_turns}',
    setup: (d) => writeFileSync(join(d, 'cipher.txt'), rot13('FLAG{rot13_wheel_turns}')),
    prompt: '현재 폴더 cipher.txt 는 ROT13으로 인코딩돼 있다. 복호화해 플래그를 보고하라.',
  },
  {
    id: 'forensics', flag: 'FLAG{198.51.100.7}',
    setup: (d) => {
      const L = [];
      const add = (ip, n, code) => { for (let i = 0; i < n; i++) L.push(`${ip} - - [10/Jan/2026:10:0${i%6}:00] "GET /admin${i} HTTP/1.1" ${code} 200`); };
      add('198.51.100.7', 9, 404);  // attacker: most 404s
      add('203.0.113.4', 3, 404);
      add('192.0.2.11', 5, 200);
      add('198.51.100.7', 2, 200);
      writeFileSync(join(d, 'access.log'), L.sort(() => 0.5 - Math.random()).join('\n') + '\n');
    },
    prompt: 'access.log 를 분석해 404 응답을 가장 많이 유발한 IP(공격자 추정)를 찾아, FLAG{그IP} 형식으로 보고하라. 예: FLAG{1.2.3.4}',
  },
  {
    id: 'hashcrack', flag: 'FLAG{s3cr3t_pass}',
    setup: (d) => {
      const words = ['admin', 'password', '123456', 'letmein', 's3cr3t_pass', 'qwerty', 'root'];
      writeFileSync(join(d, 'wordlist.txt'), words.join('\n') + '\n');
    },
    prompt: () => `다음 MD5 해시를 현재 폴더 wordlist.txt 로 크랙해 평문을 찾고, FLAG{평문} 형식으로 보고하라.\n해시: ${md5('s3cr3t_pass')}`,
  },
  {
    id: 'filehunt', flag: 'FLAG{hidden_in_plain_sight}',
    setup: (d) => {
      mkdirSync(join(d, 'files'), { recursive: true });
      for (const n of ['a', 'b', 'd', 'e']) writeFileSync(join(d, 'files', `${n}.txt`), `nothing here (${n})\n`);
      writeFileSync(join(d, 'files', 'c.txt'), 'config=1\nFLAG{hidden_in_plain_sight}\ndebug=0\n');
    },
    prompt: 'files/ 폴더 안 여러 파일 중 하나에 FLAG{...} 가 숨어 있다. 찾아서 보고하라.',
  },
  {
    id: 'exec', flag: 'FLAG{computed_4950}',
    setup: (d) => writeFileSync(join(d, 'gen.py'), 'print("FLAG{computed_%d}" % sum(range(100)))\n'),
    prompt: '현재 폴더 gen.py 를 실행하면 플래그가 출력된다. 실행해서 출력된 FLAG{...} 를 보고하라.',
  },
];

// 프로덕션과 동일한 생성 상한(폭주/과소측정 방지). temp=0으로 결정적, think off로 빠르게.
const CTF_NUM_PREDICT = (() => { const n = parseInt(process.env.OH_NUM_PREDICT ?? '4096', 10); return Number.isFinite(n) && n > 0 ? n : 4096; })();

async function solve(ch, { model, pm, backup, maxIter = 10 }) {
  const sys = '너는 OH 보안 CTF 에이전트다. 한국어로 답한다. 도구를 사용해 플래그를 직접 찾아내라.\n\n' + AGENT_DIRECTIVE;
  const prompt = typeof ch.prompt === 'function' ? ch.prompt() : ch.prompt;
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
  const tools = [...TOOL_DEFINITIONS, ...pm.allTools()].map(toOllamaTool);

  let toolsUsed = 0, foundInTools = false, lastContent = '';
  const stripThink = (s) => (s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // 프로덕션(index.js)과 동일한 에이전트 루프를 사용 — 평가 신뢰도 확보(fix#2).
  const dispatch = async (name, params) => {
    toolsUsed++;
    let r;
    try { r = await executeTool(name, params, pm, backup); }
    catch (e) { r = { error: e.message }; }
    const rs = typeof r === 'string' ? r : JSON.stringify(r);
    if (rs.includes(ch.flag)) foundInTools = true;   // 툴 출력에 플래그가 드러났는가(=능력)
    return r;
  };

  for await (const ev of runAgentTurn({
    model, messages, tools, maxIter, dispatch,
    options: { temperature: 0, num_ctx: 16384, num_predict: CTF_NUM_PREDICT, think: false },
  })) {
    if (ev.type === 'step' && stripThink(ev.content)) lastContent = stripThink(ev.content);
    if (ev.type === 'final' && stripThink(ev.content)) lastContent = stripThink(ev.content);
  }

  const reported = lastContent.includes(ch.flag);
  return { answer: lastContent, toolsUsed, reported, foundInTools, solved: reported || foundInTools };
}

export async function runCtf() {
  const model = process.env.OH_MODEL || agentModelName();
  console.log(`\n=== OH 미니 CTF 성공률 (모델=${model}) ===\n챌린지 ${CHALLENGES.length}개\n`);
  let solved = 0;
  const rows = [];
  for (const ch of CHALLENGES) {
    const dir = mkdtempSync(join(tmpdir(), `ohctf-${ch.id}-`));
    const cwd0 = process.cwd();
    try {
      ch.setup(dir);
      process.chdir(dir);
      const pm = new PluginManager(dir); await pm.load();
      const backup = new BackupManager(dir);
      const r = await solve(ch, { model, pm, backup });
      if (r.solved) solved++;
      // 판정: ✓ 보고까지 / ◐ 발견했으나 최종답변 미보고 / ✗ 미발견
      const mark = r.reported ? '✓' : (r.foundInTools ? '◐' : '✗');
      rows.push({ id: ch.id, ok: mark, tools: r.toolsUsed });
      const note = r.reported ? '' : (r.foundInTools ? '→ 툴로 찾았으나 최종답변에 미보고' : `→ 미발견 (답변: ${r.answer.slice(0, 50) || '(빈 답변)'})`);
      console.log(`  ${mark} ${ch.id.padEnd(10)} (툴 ${r.toolsUsed}회) ${note}`);
    } catch (e) {
      rows.push({ id: ch.id, ok: 'ERR', tools: 0 });
      console.log(`  ⚠ ${ch.id}: ${e.message.slice(0, 60)}`);
    } finally {
      process.chdir(cwd0);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  console.log(`\n=== 성공률 ${solved}/${CHALLENGES.length} (${(100 * solved / CHALLENGES.length).toFixed(0)}%) ===`);
  return rows;
}
