import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// 신뢰 출처 커넥터 — 권위 보안 DB에서 직접 데이터를 가져온다(추측 대신 출처).
// 큰 카탈로그(ATT&CK/ExploitDB)는 디스크에 1회 캐시 후 TTL 동안 재사용.

const CACHE_DIR = join(process.env.OH_RAG_DIR || join(homedir(), '.oh'), 'cache');
const DAY = 24 * 3600 * 1000;

function cacheDir() { mkdirSync(CACHE_DIR, { recursive: true }); return CACHE_DIR; }

// URL을 받아 캐시(파일)로 저장하고 텍스트 반환. 캐시가 신선하면 네트워크 생략.
// 네트워크 실패 시 오래된 캐시라도 있으면 사용(오프라인 견고성).
async function fetchCached(url, file, ttlMs) {
  const path = join(cacheDir(), file);
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < ttlMs) {
    return readFileSync(path, 'utf-8');
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OH-security-agent' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    writeFileSync(path, text);
    return text;
  } catch (err) {
    if (existsSync(path)) return readFileSync(path, 'utf-8');   // 만료됐어도 있으면 사용
    throw new Error(`${url} 가져오기 실패: ${err.message}`);
  }
}

// ─── CISA KEV (실제 악용중인 취약점 카탈로그, 공식/tier1) ──────────────────────
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
let _kev = null;

export async function kevLookup(cveId) {
  if (!_kev) {
    const data = JSON.parse(await fetchCached(KEV_URL, 'cisa_kev.json', DAY));
    _kev = new Map(data.vulnerabilities.map(v => [v.cveID.toUpperCase(), v]));
  }
  const v = _kev.get(cveId.toUpperCase());
  if (!v) return null;
  return {
    inKev:      true,
    name:       v.vulnerabilityName,
    dateAdded:  v.dateAdded,
    dueDate:    v.dueDate,
    ransomware: v.knownRansomwareCampaignUse,   // 'Known' | 'Unknown'
    action:     v.requiredAction,
  };
}

// ─── EPSS (FIRST.org 공식 — 악용 확률) ───────────────────────────────────────
export async function epssLookup(cveId) {
  try {
    const r = await fetch(`https://api.first.org/data/v1/epss?cve=${encodeURIComponent(cveId.toUpperCase())}`,
      { headers: { 'User-Agent': 'OH-security-agent' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const e = (await r.json()).data?.[0];
    if (!e) return null;
    return { epss: Number(e.epss), percentile: Number(e.percentile) };   // 악용확률, 백분위
  } catch { return null; }
}

// ─── GitHub Advisory (GHSA 공식 — 영향 패키지·패치버전) ───────────────────────
export async function ghsaForCve(cveId) {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'OH-security-agent' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/advisories?cve_id=${encodeURIComponent(cveId.toUpperCase())}`,
      { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const a = (await r.json())?.[0];
    if (!a) return null;
    const affected = (a.vulnerabilities ?? []).slice(0, 8).map(v => ({
      ecosystem: v.package?.ecosystem,
      package:   v.package?.name,
      range:     v.vulnerable_version_range,
      patched:   typeof v.first_patched_version === 'object' ? v.first_patched_version?.identifier : v.first_patched_version,
    }));
    return { ghsa_id: a.ghsa_id, severity: a.severity, summary: a.summary, affected };
  } catch { return null; }
}

// ─── MITRE ATT&CK (전술/기법, 공식/tier1) ────────────────────────────────────
const ATTACK_URL = 'https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json';
let _attack = null;

async function loadAttack() {
  if (_attack) return _attack;
  const bundle = JSON.parse(await fetchCached(ATTACK_URL, 'enterprise-attack.json', 7 * DAY));
  _attack = bundle.objects.filter(o => o.type === 'attack-pattern' && !o.x_mitre_deprecated && !o.revoked);
  return _attack;
}

// T-번호(T1059, T1059.001) 또는 기법명으로 조회.
export async function attackLookup(query) {
  const objs = await loadAttack();
  const q = (query || '').trim();
  const tid = q.toUpperCase().match(/T\d{4}(?:\.\d{3})?/)?.[0];
  const refId = o => o.external_references?.find(r => r.source_name === 'mitre-attack');

  let t;
  if (tid) t = objs.find(o => refId(o)?.external_id === tid);
  if (!t) {
    const lc = q.toLowerCase();
    t = objs.find(o => o.name?.toLowerCase() === lc) || objs.find(o => o.name?.toLowerCase().includes(lc));
  }
  if (!t) return null;
  const ref = refId(t);
  return {
    id:          ref?.external_id,
    name:        t.name,
    tactics:     (t.kill_chain_phases ?? []).map(p => p.phase_name),
    platforms:   t.x_mitre_platforms ?? [],
    description: t.description,
    detection:   t.x_mitre_detection ?? null,
    url:         ref?.url,
  };
}

// ─── ExploitDB (공개 익스플로잇, 커뮤니티/tier2) ──────────────────────────────
const EDB_URL = 'https://gitlab.com/exploit-database/exploitdb/-/raw/main/files_exploits.csv';
let _edb = null;

// 따옴표·개행 포함 필드를 처리하는 최소 CSV 파서.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadEdb() {
  if (_edb) return _edb;
  const rows = parseCsv(await fetchCached(EDB_URL, 'files_exploits.csv', 7 * DAY));
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  _edb = rows.slice(1).filter(r => r.length >= header.length).map(r => ({
    id:          r[idx.id],
    description: r[idx.description],
    type:        r[idx.type],
    platform:    r[idx.platform],
    date:        r[idx.date_published],
    codes:       r[idx.codes] || '',
  }));
  return _edb;
}

// CVE 번호 또는 키워드로 익스플로잇 검색.
export async function exploitSearch(query, max = 8) {
  const rows = await loadEdb();
  const q = (query || '').trim();
  const cve = q.toUpperCase().match(/CVE-\d{4}-\d{4,}/)?.[0];
  let hits;
  if (cve) hits = rows.filter(r => r.codes.toUpperCase().includes(cve));
  else {
    const terms = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    hits = rows.filter(r => { const d = r.description.toLowerCase(); return terms.every(t => d.includes(t)); });
  }
  return hits.slice(0, max).map(r => ({
    id: r.id, title: r.description, type: r.type, platform: r.platform, date: r.date,
    cves: r.codes, url: `https://www.exploit-db.com/exploits/${r.id}`,
  }));
}

// ─── 개발 라이브러리 (공식 레지스트리 — 최신버전·취약점, 휘발성→무캐시 라이브) ──
// 프로그래밍 "최신성"은 모델/정적KB가 아니라 공식 레지스트리 라이브 조회로. [project_dev_knowledge_freshness]
const OSV_API = 'https://api.osv.dev/v1/query';

async function osvVulns(ecosystem, name, version) {
  try {
    const body = version
      ? { package: { ecosystem, name }, version }
      : { package: { ecosystem, name } };
    const res = await fetch(OSV_API, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    return ((await res.json()).vulns ?? []).map(v => ({ id: v.id, summary: v.summary }));
  } catch { return []; }
}

// ecosystem: npm | pypi | crates | go. 최신버전·설명·deprecation + OSV 취약점.
export async function depLookup({ ecosystem, name, version } = {}) {
  const eco = (ecosystem || '').toLowerCase();
  const n = (name || '').trim();
  if (!n) return null;
  const ua = { 'User-Agent': 'OH-security-agent' }, to = AbortSignal.timeout(15_000);
  let info = null, osvEco = null;

  try {
    if (eco === 'npm') {
      osvEco = 'npm';
      const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(n).replace('%40', '@')}/latest`, { headers: ua, signal: to });
      if (r.ok) { const j = await r.json(); info = { latest: j.version, description: j.description, deprecated: j.deprecated ?? null, homepage: j.homepage }; }
    } else if (eco === 'pypi') {
      osvEco = 'PyPI';
      const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(n)}/json`, { headers: ua, signal: to });
      if (r.ok) { const j = await r.json(); info = { latest: j.info.version, description: j.info.summary, deprecated: j.info.yanked ? 'yanked' : null, homepage: j.info.home_page }; }
    } else if (eco === 'crates') {
      osvEco = 'crates.io';
      const r = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(n)}`, { headers: ua, signal: to });
      if (r.ok) { const j = await r.json(); info = { latest: j.crate.max_stable_version || j.crate.newest_version, description: j.crate.description, deprecated: null, homepage: j.crate.homepage }; }
    } else if (eco === 'go') {
      osvEco = 'Go';
      const r = await fetch(`https://proxy.golang.org/${n.toLowerCase()}/@latest`, { headers: ua, signal: to });
      if (r.ok) { const j = await r.json(); info = { latest: j.Version, description: null, deprecated: null, homepage: `https://pkg.go.dev/${n}` }; }
    } else {
      return { error: `지원 안 하는 ecosystem: ${ecosystem} (npm|pypi|crates|go)` };
    }
  } catch { /* 네트워크 오류 → info null */ }

  if (!info?.latest) return { found: false, ecosystem: eco, name: n };
  const vulns = await osvVulns(osvEco, n, version);
  return { found: true, ecosystem: eco, name: n, ...info, queriedVersion: version ?? null, vulnerabilities: vulns };
}

// 런타임/프레임워크 지원종료(EOL) — endoflife.date.
export async function eolLookup(product) {
  const p = (product || '').toLowerCase().trim().replace(/[^a-z0-9.-]/g, '');
  if (!p) return null;
  try {
    const t = await fetchCached(`https://endoflife.date/api/${p}.json`, `eol_${p}.json`, DAY);
    if (/^404/.test(t.trim())) return null;
    const cycles = JSON.parse(t);
    return cycles.slice(0, 6).map(c => ({ cycle: c.cycle, latest: c.latest, releaseDate: c.releaseDate, eol: c.eol, lts: c.lts }));
  } catch { return null; }
}

// ─── GTFOBins (유닉스 바이너리 악용/권한상승, 커뮤니티/tier2) ──────────────────
const GTFO_RAW = bin => `https://raw.githubusercontent.com/GTFOBins/GTFOBins.github.io/master/_gtfobins/${bin}`;

// ─── GitHub 저장소 마크다운 일괄 적재 (지식 대량적재용) ───────────────────────
// 트리 API 1회로 전체 파일목록 → .md만 필터(rate limit 절약). 내용은 raw로 받음(무제한).
export async function loadGithubMarkdown(owner, repo, { branch, pathPrefix = '', onlyReadme = false, max = 100, exts = ['.md'], pathPrefixes = null, excludeRe = null } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'OH-security-agent' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let br = branch;
  if (!br) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(15_000) });
    br = r.ok ? (await r.json()).default_branch : 'main';
  }
  const tr = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${br}?recursive=1`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!tr.ok) throw new Error(`GitHub tree ${tr.status} (${owner}/${repo}@${br})`);
  // 텍스트 지식 확장자 허용(.md 외 .txt/.rst/.markdown 등). exts 소문자 비교.
  const extList = exts.map(e => e.toLowerCase());
  let files = (await tr.json()).tree.filter(t => {
    if (t.type !== 'blob') return false;
    const p = t.path.toLowerCase();
    return extList.some(e => p.endsWith(e));
  });
  // 경로 필터: 단일 pathPrefix 또는 복수 pathPrefixes(OR) — 대형 리포에서 핵심 경로만.
  if (pathPrefixes && pathPrefixes.length) {
    files = files.filter(t => pathPrefixes.some(pre => t.path.startsWith(pre)));
  } else if (pathPrefix) {
    files = files.filter(t => t.path.startsWith(pathPrefix));
  }
  if (excludeRe)   files = files.filter(t => !excludeRe.test(t.path));
  if (onlyReadme)  files = files.filter(t => t.path.toLowerCase().endsWith('readme.md'));
  files = files.slice(0, max);
  return {
    branch: br,
    files: files.map(f => ({ path: f.path, rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${encodeURI(f.path)}` })),
  };
}

// ─── LOLBAS (윈도우 living-off-the-land 바이너리, 커뮤니티/tier2) ─────────────
const LOLBAS_URL = 'https://lolbas-project.github.io/api/lolbas.json';
let _lolbas = null;

export async function lolbasLookup(name) {
  const q = (name || '').toLowerCase().trim();
  if (!q) return null;
  if (!_lolbas) _lolbas = JSON.parse(await fetchCached(LOLBAS_URL, 'lolbas.json', 7 * DAY));
  const want = q.endsWith('.exe') ? q : q + '.exe';
  const e = _lolbas.find(x => x.Name?.toLowerCase() === want)
         || _lolbas.find(x => x.Name?.toLowerCase() === q)
         || _lolbas.find(x => x.Name?.toLowerCase().startsWith(q));
  if (!e) return null;
  return {
    name: e.Name,
    commands: (e.Commands ?? []).slice(0, 8).map(c => ({ command: c.Command, description: c.Description, category: c.Category })),
    url: e.url || `https://lolbas-project.github.io/lolbas/Binaries/${e.Name?.replace(/\.exe$/i, '')}/`,
  };
}

export async function gtfobinsLookup(binary) {
  const name = (binary || '').toLowerCase().trim().replace(/[^a-z0-9_.+-]/g, '');
  if (!name) return null;
  let md;
  try { md = await fetchCached(GTFO_RAW(name), `gtfobins_${name}.md`, 7 * DAY); }
  catch { return null; }
  if (/^404/.test(md.trim())) return null;

  // YAML 프런트매터에서 기능명(shell/suid/sudo 등)과 코드 추출.
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const body = fm ? fm[1] : md;
  const funcMatch = body.match(/functions:\s*\n([\s\S]*)/);
  const functions = funcMatch
    ? [...new Set((funcMatch[1].match(/^\s{2}(\w[\w-]*):/gm) || []).map(s => s.trim().replace(':', '')))]
    : [];
  return {
    binary: name,
    functions,
    url: `https://gtfobins.github.io/gtfobins/${name}/`,
    detail: body.slice(0, 2500),   // 코드 스니펫 포함 원문(권위 데이터)
  };
}
