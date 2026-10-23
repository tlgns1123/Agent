# 암호학 공격/유틸 (검증된 구조)

허가된 연구/CTF 전제. pycryptodome(`pip install pycryptodome`) 사용.

## XOR (반복키 — zip 함정 방지)
```python
import itertools

def xor(data: bytes, key: bytes) -> bytes:
    # zip(data, key)는 키 길이에서 끊김 → itertools.cycle로 키 반복(데이터 손상 방지).
    return bytes(b ^ k for b, k in zip(data, itertools.cycle(key)))

ct = xor(b"secret message", b"KEY")
assert xor(ct, b"KEY") == b"secret message"   # 대칭
```

## 단일바이트 XOR 브루트포스 (CTF 빈출)
```python
def single_byte_xor_crack(ct: bytes) -> tuple[int, bytes]:
    best = (0, b"", -1.0)
    freq = b"etaoin shrdlu ETAOIN"           # 영문 빈도 스코어링
    for k in range(256):
        pt = bytes(c ^ k for c in ct)
        score = sum(pt.count(ch) for ch in freq)
        if score > best[2]:
            best = (k, pt, score)
    return best[0], best[1]
```

## AES-CBC 암복호화 (PKCS7 패딩)
```python
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from Crypto.Random import get_random_bytes

def aes_cbc_encrypt(pt: bytes, key: bytes) -> tuple[bytes, bytes]:
    iv = get_random_bytes(16)
    c = AES.new(key, AES.MODE_CBC, iv)
    return iv, c.encrypt(pad(pt, AES.block_size))

def aes_cbc_decrypt(iv: bytes, ct: bytes, key: bytes) -> bytes:
    c = AES.new(key, AES.MODE_CBC, iv)
    return unpad(c.decrypt(ct), AES.block_size)
```

## 패딩 오라클 공격 (CBC, 블록당 복호화)
```python
def padding_oracle_block(oracle, prev: bytes, target: bytes) -> bytes:
    """oracle(iv_or_prev, block) -> 패딩유효 여부 bool. 한 블록(16B) 평문 복원."""
    bs = 16
    inter = bytearray(bs)        # 중간값 D(target)
    recovered = bytearray(bs)
    for pad_val in range(1, bs + 1):
        forged = bytearray(bs)
        for i in range(1, pad_val):
            forged[bs - i] = inter[bs - i] ^ pad_val
        for guess in range(256):
            forged[bs - pad_val] = guess
            if oracle(bytes(forged), target):
                inter[bs - pad_val] = guess ^ pad_val
                recovered[bs - pad_val] = inter[bs - pad_val] ^ prev[bs - pad_val]
                break
    return bytes(recovered)
```

## 해시 식별 + 타이밍 안전 비교
```python
import hmac
import hashlib

def identify_hash(h: str) -> list[str]:
    n = len(h.strip())
    table = {32: ["MD5", "NTLM"], 40: ["SHA1"], 64: ["SHA256"], 128: ["SHA512"]}
    return table.get(n, ["unknown"])

def safe_compare(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)         # 사이드채널(타이밍) 방지

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
```

## 크랙 명령 레시피 (hashcat / john)
```python
# 참고용 명령 모음 (문자열) — 실제 실행은 셸에서.
HASHCAT = {
    "md5":    "hashcat -m 0 -a 0 hashes.txt rockyou.txt",
    "ntlm":   "hashcat -m 1000 -a 0 hashes.txt rockyou.txt -r rules/best64.rule",
    "sha256": "hashcat -m 1400 -a 0 hashes.txt rockyou.txt",
    "bcrypt": "hashcat -m 3200 -a 0 hashes.txt rockyou.txt",
}
JOHN = "john --wordlist=rockyou.txt --rules hashes.txt && john --show hashes.txt"
```
