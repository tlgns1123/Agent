# 정찰 / 열거 (검증된 구조)

허가된 범위 스캔 전제. 표준 recon 프리미티브.

## TCP connect 포트 스캐너 (스레드풀)
```python
import socket
from concurrent.futures import ThreadPoolExecutor

def check_port(host: str, port: int, timeout: float = 1.0) -> int | None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return port if s.connect_ex((host, port)) == 0 else None

def scan(host: str, ports: range, workers: int = 100) -> list[int]:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = ex.map(lambda p: check_port(host, p), ports)
    return sorted(p for p in results if p is not None)

# 사용: scan("127.0.0.1", range(1, 1025))
```

## 배너 그래빙
```python
import socket

def grab_banner(host: str, port: int, timeout: float = 3.0) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect((host, port))
        try:
            return s.recv(1024).decode(errors="replace").strip()
        except socket.timeout:
            return ""
```

## DNS 해석 + 서브도메인 열거 (워드리스트)
```python
import socket

def resolve(name: str) -> list[str]:
    try:
        return list({ai[4][0] for ai in socket.getaddrinfo(name, None)})
    except socket.gaierror:
        return []

def enum_subdomains(domain: str, words: list[str]) -> dict[str, list[str]]:
    found = {}
    for w in words:
        fqdn = f"{w}.{domain}"
        ips = resolve(fqdn)
        if ips:
            found[fqdn] = ips
    return found
```

## HTTP 핑거프린팅 (서버/타이틀/기술)
```python
import re
import requests

def fingerprint(sess: requests.Session, url: str) -> dict:
    r = sess.get(url, timeout=10, allow_redirects=True)
    title = re.search(r"<title>(.*?)</title>", r.text, re.I | re.S)
    return {
        "status": r.status_code,
        "server": r.headers.get("Server", ""),
        "powered_by": r.headers.get("X-Powered-By", ""),
        "title": title.group(1).strip() if title else "",
        "cookies": list(r.cookies.keys()),
    }
```

## 디렉터리/파일 브루트포스 (레이트 고려)
```python
import requests

def dir_brute(sess: requests.Session, base: str, words: list[str],
              exts: tuple[str, ...] = ("", ".php", ".bak", ".old")) -> list[tuple[str, int]]:
    hits = []
    for w in words:
        for ext in exts:
            path = f"{base.rstrip('/')}/{w}{ext}"
            r = sess.get(path, timeout=8, allow_redirects=False)
            if r.status_code not in (404,):
                hits.append((path, r.status_code))
    return hits
```
