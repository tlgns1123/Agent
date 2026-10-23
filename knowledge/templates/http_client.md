# HTTP 클라이언트 베이스 (requests / httpx)

웹 테스트·스크래핑·API 상호작용의 검증된 기본기. 세션 재사용·재시도·타임아웃·프록시(Burp 연동)·인증.

## requests Session (재시도 + 타임아웃 + 공통 헤더)
```python
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

def make_session(proxy: str | None = None, verify_tls: bool = True) -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5,
                  status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=frozenset({"GET", "POST", "HEAD"}))
    s.mount("http://", HTTPAdapter(max_retries=retry))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": "Mozilla/5.0 (research)"})
    if proxy:  # 예: "http://127.0.0.1:8080" (Burp)
        s.proxies.update({"http": proxy, "https": proxy})
    s.verify = verify_tls
    return s

sess = make_session(proxy="http://127.0.0.1:8080", verify_tls=False)
r = sess.get("http://example.com", timeout=10)
print(r.status_code, len(r.text))
```

## GET/POST — 쿼리·폼·JSON·파일 업로드
```python
import requests

def examples(sess: requests.Session, base: str):
    sess.get(base, params={"q": "test", "page": 1}, timeout=10)              # 쿼리스트링
    sess.post(base + "/login", data={"user": "admin", "pw": "x"}, timeout=10)  # 폼
    sess.post(base + "/api", json={"key": "value"}, timeout=10)              # JSON 바디
    with open("payload.bin", "rb") as f:                                     # 멀티파트 업로드
        sess.post(base + "/upload", files={"file": ("a.bin", f, "application/octet-stream")}, timeout=10)
```

## 응답 비교 오라클 (블라인드 인젝션/권한 테스트용)
```python
import requests

def response_signature(r: requests.Response) -> tuple[int, int]:
    """상태코드 + 본문길이. 블라인드 테스트에서 참/거짓 구분용(상태코드 단독보다 견고)."""
    return r.status_code, len(r.text)

def differs(sess: requests.Session, url: str, p_true: dict, p_false: dict) -> bool:
    a = response_signature(sess.get(url, params=p_true, timeout=10))
    b = response_signature(sess.get(url, params=p_false, timeout=10))
    return a != b
```

## httpx 비동기 클라이언트 (대량 병렬 요청)
```python
import asyncio
import httpx

async def fetch_all(urls: list[str], concurrency: int = 20) -> list[tuple[str, int]]:
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(timeout=10, verify=False) as client:
        async def one(u):
            async with sem:
                try:
                    r = await client.get(u)
                    return u, r.status_code
                except httpx.HTTPError:
                    return u, -1
        return await asyncio.gather(*(one(u) for u in urls))

out = asyncio.run(fetch_all(["http://example.com"]))
```

## 쿠키/세션 토큰 수동 관리
```python
import requests

def with_bearer(sess: requests.Session, token: str) -> requests.Session:
    sess.headers["Authorization"] = f"Bearer {token}"
    return sess

def set_cookie(sess: requests.Session, name: str, value: str, domain: str) -> None:
    sess.cookies.set(name, value, domain=domain)
```
