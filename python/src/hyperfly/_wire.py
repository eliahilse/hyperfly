from __future__ import annotations

from array import array
from dataclasses import dataclass
from typing import Any, Callable, Iterable

INT_MIN = -(2**53 - 1)
INT_MAX = 2**53 - 1
_ULEB_DOMAIN_MAX = (1 << 56) - 1
_MAX_ULEB_BYTES = 8


class HyperflyError(Exception):
    """A Hyperfly failure with a stable ``code`` and descriptive message."""

    code = "ir"

    def __init__(self, code: str, message: str) -> None:
        """Store the error code and human-readable message."""
        super().__init__(message)
        self.code = code


class EncodeError(HyperflyError):
    """An invalid input value or exceeded encoding bound, identified by ``code``."""


class DecodeError(HyperflyError):
    """Malformed binary data or an exceeded decoding bound, identified by ``code``."""


class FingerprintMismatchError(DecodeError):
    """Code ``fingerprint`` with hexadecimal ``expected`` and ``actual`` fingerprints."""

    def __init__(self, expected: str, actual: str) -> None:
        """Record the codec fingerprint and the envelope fingerprint it received."""
        super().__init__("fingerprint", f"codec fingerprint {expected} does not match payload {actual}")
        self.expected = expected
        self.actual = actual


class UnsupportedSchemaError(HyperflyError):
    """Code ``unsupported`` with the model field ``path`` that has no v0 encoding."""

    def __init__(self, path: str, message: str) -> None:
        """Record the unsupported field path and explain its encoding limitation."""
        super().__init__("unsupported", f"{path}: {message}")
        self.path = path


@dataclass(frozen=True)
class Limits:
    """Immutable per-value and aggregate resource bounds (wire-v0 section 6).

    max_depth bounds nesting; max_items bounds an array's item count;
    max_byte_length bounds a string, byte value, or packed blob. max_total_items
    and max_total_bytes cap a body's decoded items and bytes. max_amplification
    and max_byte_amplification bound those totals relative to encoded body size.
    """

    max_depth: int = 64
    max_items: int = 2**24
    max_byte_length: int = 2**28
    max_amplification: int = 32
    max_total_items: int = 2**24
    max_total_bytes: int = 2**26
    max_byte_amplification: int = 64

    def item_budget(self, body_length: int) -> int:
        """Items one body may declare across all its arrays: wire-v0 section 6."""
        return min(self.max_total_items, self.max_amplification * (body_length + 1))

    def byte_budget(self, body_length: int) -> int:
        """Decoded bytes of every string and bytes value in one body: wire-v0 section 6."""
        return min(self.max_total_bytes, self.max_byte_amplification * (body_length + 1))


DEFAULT_LIMITS = Limits()


class Budget:
    """The item and byte budgets of one body. A column whose decoded bytes are
    bounded within the byte budget defers its exact total, which is settled only
    once a later charge needs it."""

    __slots__ = ("cap", "total", "byte_cap", "bytes", "owed", "deferred")

    def __init__(self, cap: int, byte_cap: int) -> None:
        self.cap = cap
        self.total = 0
        self.byte_cap = byte_cap
        self.bytes = 0
        self.owed = 0
        self.deferred: list[tuple[int, Callable[[], int]]] = []

    def charge(self, count: int, path: str, error: type[HyperflyError]) -> None:
        if count > self.cap - self.total:
            raise error("limit", f"{path}: {self.total + count} items exceed the item budget of {self.cap}")
        self.total += count

    def charge_bytes(self, length: int, path: str, error: type[HyperflyError]) -> None:
        if length > self.byte_cap - self.bytes - self.owed:
            self.settle()
            if length > self.byte_cap - self.bytes:
                raise error("limit", f"{path}: {self.bytes + length} bytes exceed the byte budget of {self.byte_cap}")
        self.bytes += length

    def defer_bytes(self, bound: int, exact: Callable[[], int]) -> bool:
        """Charge a total of at most `bound` bytes, computed by `exact` only when
        needed, if the bound fits what remains."""
        if bound > self.byte_cap - self.bytes - self.owed:
            return False
        self.deferred.append((bound, exact))
        self.owed += bound
        return True

    def settle(self) -> None:
        """Charge the exact totals deferred so far."""
        for _bound, exact in self.deferred:
            self.bytes += exact()
        self.deferred.clear()
        self.owed = 0


class Reader:
    __slots__ = ("buf", "pos", "limits", "budget", "deferred")

    def __init__(self, buf: bytes, limits: Limits) -> None:
        self.buf = buf
        self.pos = 0
        self.limits = limits
        self.budget = Budget(limits.item_budget(len(buf)), limits.byte_budget(len(buf)))
        # arrays whose items are built only once the whole body has decoded
        self.deferred: list[tuple[list[Any], Callable[[], Iterable[Any]]]] = []

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


def uleb_at(buf: bytes, pos: int) -> tuple[int, int]:
    """read_uleb over a buffer position: the value and the position after it."""
    result = 0
    shift = 0
    for i in range(_MAX_ULEB_BYTES):
        if pos >= len(buf):
            raise DecodeError("truncated", "unexpected end of input")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            if i > 0 and byte == 0:
                raise DecodeError("varint", "overlong uvarint encoding")
            return result, pos
        shift += 7
    raise DecodeError("varint", f"uvarint longer than {_MAX_ULEB_BYTES} bytes")


def read_ulebs(r: Reader, count: int) -> tuple[array[int], DecodeError | None]:
    """Up to `count` uvarints, stopping at the first malformed one. Its error is
    returned rather than raised, so a caller can report an earlier value first."""
    buf = r.buf
    pos = r.pos
    window = buf[pos : pos + count]
    if len(window) == count and window.isascii():
        r.pos = pos + count
        return array("B", window), None
    out = array("Q")
    append = out.append
    end = len(buf)
    for _ in range(count):
        if pos < end and buf[pos] < 0x80:
            append(buf[pos])
            pos += 1
            continue
        try:
            value, pos = uleb_at(buf, pos)
        except DecodeError as err:
            return out, err
        append(value)
    r.pos = pos
    return out, None


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


def read_bits(r: Reader, count: int, path: str) -> int:
    """A count-bit bitmap as one integer, bit i for row i."""
    bits = int.from_bytes(r.take((count + 7) >> 3), "little")
    if bits >> count:
        raise DecodeError("bitmap", f"{path}: nonzero bitmap padding")
    return bits


def read_bitmap(r: Reader, count: int, path: str) -> list[bool]:
    bits: list[bool] = []
    for base in range(0, count, 8):
        byte = r.u8()
        used = min(8, count - base)
        if used < 8 and byte >> used != 0:
            raise DecodeError("bitmap", f"{path}: nonzero bitmap padding")
        bits.extend(bool(byte & (1 << i)) for i in range(used))
    return bits
