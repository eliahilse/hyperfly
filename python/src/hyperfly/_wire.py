from __future__ import annotations

from dataclasses import dataclass

INT_MIN = -(2**53 - 1)
INT_MAX = 2**53 - 1
_ULEB_DOMAIN_MAX = (1 << 56) - 1
_MAX_ULEB_BYTES = 8


class HyperflyError(Exception):
    code = "ir"

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class EncodeError(HyperflyError):
    pass


class DecodeError(HyperflyError):
    pass


class FingerprintMismatchError(DecodeError):
    def __init__(self, expected: str, actual: str) -> None:
        super().__init__("fingerprint", f"codec fingerprint {expected} does not match payload {actual}")
        self.expected = expected
        self.actual = actual


class UnsupportedSchemaError(HyperflyError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__("unsupported", f"{path}: {message}")
        self.path = path


@dataclass(frozen=True)
class Limits:
    max_depth: int = 64
    max_items: int = 2**24
    max_byte_length: int = 2**28
    max_amplification: int = 4096


DEFAULT_LIMITS = Limits()


class Reader:
    __slots__ = ("buf", "pos", "limits")

    def __init__(self, buf: bytes, limits: Limits) -> None:
        self.buf = buf
        self.pos = 0
        self.limits = limits

    def u8(self) -> int:
        if self.pos >= len(self.buf):
            raise DecodeError("truncated", "unexpected end of input")
        b = self.buf[self.pos]
        self.pos += 1
        return b

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.buf):
            raise DecodeError("truncated", "unexpected end of input")
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out

    def remaining(self) -> int:
        return len(self.buf) - self.pos

    def expect_end(self) -> None:
        if self.pos != len(self.buf):
            raise DecodeError("trailing", f"{len(self.buf) - self.pos} trailing byte(s) after body")


def write_uleb(out: bytearray, value: int) -> None:
    if value < 0 or value > _ULEB_DOMAIN_MAX:
        raise EncodeError("range", f"uvarint out of v0 domain: {value}")
    while True:
        group = value & 0x7F
        value >>= 7
        if value == 0:
            out.append(group)
            return
        out.append(group | 0x80)


def read_uleb(r: Reader) -> int:
    result = 0
    shift = 0
    for i in range(_MAX_ULEB_BYTES):
        byte = r.u8()
        group = byte & 0x7F
        result |= group << shift
        if not byte & 0x80:
            if i > 0 and group == 0:
                raise DecodeError("varint", "overlong uvarint encoding")
            return result
        shift += 7
    raise DecodeError("varint", f"uvarint longer than {_MAX_ULEB_BYTES} bytes")


def uleb_len(value: int) -> int:
    length = 1
    while value > 0x7F:
        value >>= 7
        length += 1
    return length


def zigzag(v: int) -> int:
    return v << 1 if v >= 0 else ((-v) << 1) - 1


def unzigzag(u: int) -> int:
    return -((u + 1) >> 1) if u & 1 else u >> 1


def write_bitmap(out: bytearray, bits: list[bool]) -> None:
    for base in range(0, len(bits), 8):
        byte = 0
        for offset, bit in enumerate(bits[base : base + 8]):
            if bit:
                byte |= 1 << offset
        out.append(byte)


def read_bitmap(r: Reader, count: int, path: str) -> list[bool]:
    bits: list[bool] = []
    for base in range(0, count, 8):
        byte = r.u8()
        used = min(8, count - base)
        if used < 8 and byte >> used != 0:
            raise DecodeError("bitmap", f"{path}: nonzero bitmap padding")
        bits.extend(bool(byte & (1 << i)) for i in range(used))
    return bits
