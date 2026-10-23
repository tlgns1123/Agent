# Python 코딩 베이스 (검증된 재사용 스니펫)

실행 가능한 완전판 빌딩블록. 프로젝트 배선(CLI·로깅·설정·동시성·subprocess·파일IO)에서 막히지 않도록 하는 기본기.

## argparse CLI 스캐폴드
```python
import argparse
import sys

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="도구 설명")
    p.add_argument("target", help="대상 (URL/IP/호스트)")
    p.add_argument("-p", "--port", type=int, default=80, help="포트 (기본 80)")
    p.add_argument("-t", "--threads", type=int, default=10, help="스레드 수")
    p.add_argument("-o", "--output", help="결과 저장 파일")
    p.add_argument("-v", "--verbose", action="store_true", help="상세 출력")
    return p

def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.verbose:
        print(f"[*] target={args.target} port={args.port}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

## 로깅 설정 (파일 + 콘솔)
```python
import logging

def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    logger.setLevel(level)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    fh = logging.FileHandler("run.log", encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    return logger

log = get_logger("app")
log.info("시작")
```

## 환경변수 설정 로딩 (시크릿 하드코딩 금지)
```python
import os

def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(f"환경변수 {name} 가 설정되지 않았습니다")
    return val

API_KEY = require_env("API_KEY")
DB_URL = os.environ.get("DB_URL", "sqlite:///local.db")  # 기본값 허용 항목
```

## 안전한 subprocess 실행 (shell=False, 타임아웃, 결과캡처)
```python
import subprocess

def run(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """cmd는 리스트로 — shell=True + 문자열은 명령어 인젝션 위험."""
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return cp.returncode, cp.stdout, cp.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"

code, out, err = run(["whoami"])
print(code, out.strip())
```

## 재시도 데코레이터 (지수 백오프)
```python
import time
import functools

def retry(times: int = 3, delay: float = 0.5, backoff: float = 2.0, exceptions=(Exception,)):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            d = delay
            last = None
            for _ in range(times):
                try:
                    return fn(*args, **kwargs)
                except exceptions as e:
                    last = e
                    time.sleep(d)
                    d *= backoff
            raise last
        return wrapper
    return deco

@retry(times=4, exceptions=(ConnectionError,))
def flaky():
    raise ConnectionError("임시 실패")
```

## asyncio 동시성 워커 풀 (세마포어로 동시수 제한)
```python
import asyncio

async def worker(sem: asyncio.Semaphore, item):
    async with sem:
        await asyncio.sleep(0.1)  # 실제 작업으로 교체
        return item * 2

async def run_pool(items, concurrency: int = 10):
    sem = asyncio.Semaphore(concurrency)
    tasks = [asyncio.create_task(worker(sem, it)) for it in items]
    return await asyncio.gather(*tasks)

results = asyncio.run(run_pool(range(20), concurrency=5))
```

## UTF-8 파일 읽기/쓰기 + JSON
```python
import json
from pathlib import Path

def read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")

def write_json(path: str, data: dict) -> None:
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def read_lines(path: str) -> list[str]:
    return [ln.strip() for ln in Path(path).read_text(encoding="utf-8").splitlines() if ln.strip()]
```
