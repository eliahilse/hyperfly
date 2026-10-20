from __future__ import annotations

import copy
import dataclasses
import itertools
import math
import struct
import sys
import zlib
from array import array
from bisect import bisect_right
from collections import Counter
from collections.abc import Mapping
from functools import partial
from itertools import accumulate, chain, compress, islice, repeat
from operator import add, and_, lshift, not_, sub, truediv
from typing import Any, Callable, Iterable, Iterator, NoReturn

from ._ir import (
    LEAF_KINDS,
    _fail,
    column_count,
    fingerprint_of,
    has_payload,
    normalize_integers,
    serialize_artifact,
    validate_ir,
    validate_profile,
)
from ._wire import (
    HyperflyError,
    DEFAULT_LIMITS,
    INT_MAX,
    INT_MIN,
    DecodeError,
    EncodeError,
    FingerprintMismatchError,
    Budget,
    Limits,
    Reader,
    read_bitmap,
    read_bits,
    read_uleb,
    read_ulebs,
    uleb_at,
    uleb_len,
    unzigzag,
    write_bitmap,
    write_uleb,
    zigzag,
)

MAGIC = b"hf"
WIRE_VERSION = 1
HEADER_SIZE = 19

_NEG_ZERO_BITS = 0x8000000000000000
_POW10 = [10**i for i in range(9)]
_MAX_SCALE = 8


def _bound_amplification(r: Reader, count: int, path: str) -> None:
    limit = r.limits.max_amplification
    if count > (r.remaining() + 1) * limit:
        _dfail(
            "limit",
            path,
            f"{count} rows from {r.remaining()} remaining byte(s) exceeds the amplification limit",
        )


def _bound_by_input(r: Reader, count: int, zero_bit: bool, path: str) -> None:
    """Apply the row encoding's one-bit floor, falling back to amplification for
    zero-bit elements."""
    if zero_bit:
        _bound_amplification(r, count, path)
        return
    if count > r.remaining() * 8:
        _dfail("limit", path, f"declared {count} items but only {r.remaining()} byte(s) remain")


def _check_amplification(count: int, payload_bytes: int, floor: bool, ctx: _Ctx, path: str) -> None:
    """The decoder's bounds with the array's own bytes after its count in place of
    remaining bytes, so whatever the encoder accepts its decoder accepts too. The
    floor applies to a row-encoded array of non-zero-bit elements, which can still
    pack to nothing (a fixed columnar array of single-member enums)."""
    if count > (payload_bytes + 1) * ctx.max_amplification:
        _efail(
            "limit",
            path,
            f"{count} rows in {payload_bytes} payload byte(s) exceeds the amplification limit",
        )
    if floor and count > payload_bytes * 8:
        _efail("limit", path, f"{count} items in {payload_bytes} payload byte(s) fall below the one-bit floor")


def _efail(code: str, path: str, message: str) -> None:
    raise EncodeError(code, f"{path}: {message}")


def _dfail(code: str, path: str, message: str) -> NoReturn:
    raise DecodeError(code, f"{path}: {message}")


def _is_int(v: Any) -> bool:
    return type(v) is int and INT_MIN <= v <= INT_MAX


def _float_bits(v: float) -> int:
    return struct.unpack("<Q", struct.pack("<d", v))[0]


def _bits_float(bits: int) -> float:
    return struct.unpack("<d", struct.pack("<Q", bits))[0]


def _canon_float(v: Any, path: str) -> float:
    if type(v) is bool or not isinstance(v, (int, float)):
        _efail("type", path, "expected number")
    try:
        f = float(v)
    except OverflowError:
        _efail("float", path, "float64 must be finite")
    if not math.isfinite(f):
        _efail("float", path, "float64 must be finite")
    return 0.0 if f == 0 else f


def _utf8(v: Any, path: str) -> bytes:
    if type(v) is not str:
        _efail("type", path, "expected string")
    try:
        return v.encode("utf-8")
    except UnicodeEncodeError:
        _efail("utf8", path, "lone surrogate")
    raise AssertionError


def _text_bytes(text: str) -> int:
    return len(text) if text.isascii() else len(text.encode("utf-8"))


def _type_accepts_null(node: dict[str, Any]) -> bool:
    return node["kind"] == "nullable" or (node["kind"] == "literal" and node["value"] is None)


def _literal_matches(lit: Any, v: Any) -> bool:
    if lit is None:
        return v is None
    if type(lit) is bool:
        return v is lit
    if type(lit) is int:
        # zero is the integer 0 whatever its sign, so a float -0.0 or 0.0 matches literal 0
        return (type(v) is int and v == lit) or (lit == 0 and type(v) is float and v == 0)
    return type(v) is str and v == lit


_MAX_WIDTH = 56


def _bit_width(max_value: int) -> int:
    """Bits needed for an unsigned value; zero for zero, so a constant column packs to nothing."""
    return max_value.bit_length()


def _packed_bytes(count: int, width: int) -> int:
    return -(-count * width // 8) if width else 0


def _pack_bits(out: bytearray, values: list[int], width: int) -> None:
    """Spec 3.1: little-endian bit stream, value i at bits [i*w, (i+1)*w)."""
    if width == 0:
        return
    acc = 0
    bits = 0
    for value in values:
        acc |= value << bits
        bits += width
        while bits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            bits -= 8
    if bits:
        out.append(acc & 0xFF)


_UINT = {1: "B", 2: "H", 4: "I" if array("I").itemsize == 4 else "L", 8: "Q"}
_BIG_ENDIAN = sys.byteorder == "big"
_BIT_BYTES = bytes.maketrans(b"01", b"\x00\x01")
_FLAG_BITS = bytes.maketrans(bytes(range(256)), b"0" + b"1" * 255)
_CONTINUATION = bytes.maketrans(bytes(range(256)), bytes(0x80 <= b < 0xC0 for b in range(256)))
_EXPONENT = 0x7FF0000000000000
_BOOLS = (False, True)
# dictionary codes fit 14 bits, so this one marks a row in which the source is absent
_NOT_PARTICIPATING = 0xFFFF
_MISSING_CODES = frozenset({0, _NOT_PARTICIPATING})


def _unpack_bits(r: Reader, count: int, width: int, path: str) -> array | None:
    """Spec 3.1 values as one unsigned array, or None at width zero, where every value is zero."""
    if width > _MAX_WIDTH:
        _dfail("marker", path, f"bit width {width} exceeds {_MAX_WIDTH}")
    if width == 0:
        return None
    data = r.take(_packed_bytes(count, width))
    # leftover bits are padding and must be zero, or one value would have two encodings
    if data and data[-1] >> (count * width - 8 * (len(data) - 1)):
        _dfail("bitmap", path, "nonzero bit-packing padding")
    return _widen(data, count, width)


def _widen(data: bytes, count: int, width: int) -> array:
    """Fields of `width` bits into the narrowest machine-word array that holds them."""
    slot = 8 if width <= 8 else 16 if width <= 16 else 32 if width <= 32 else 64
    size = slot // 8
    out = array(_UINT[size])
    if width == slot:
        out.frombytes(data)
    elif count <= 64:
        bits = int.from_bytes(data, "little")
        mask = (1 << width) - 1
        out.extend((bits >> (i * width)) & mask for i in range(count))
        return out
    elif width % 8 == 0:
        stride = width // 8
        wide = bytearray(count * size)
        for j in range(stride):
            memoryview(wide)[j::size] = memoryview(data)[j::stride]
        out.frombytes(wide)
    else:
        # eight fields fill exactly `width` bytes: give each group of eight its own
        # eight slots, then spread the fields inside every group in three halving steps
        groups = -(-count // 8)
        source = memoryview(data.ljust(groups * width, b"\0"))
        wide = bytearray(groups * 8 * size)
        for j in range(width):
            memoryview(wide)[j :: 8 * size] = source[j::width]
        bits = int.from_bytes(wide, "little")
        half = 4
        while half:
            run = half * width
            pattern = (((1 << run) - 1) << run).to_bytes(2 * half * size, "little")
            moved = bits & int.from_bytes(pattern * (4 * groups // half), "little")
            bits = (bits ^ moved) | (moved << half * (slot - width))
            half >>= 1
        out.frombytes(bits.to_bytes(len(wide), "little"))
    if _BIG_ENDIAN and size > 1:
        out.byteswap()
    del out[count:]
    return out


def _selector(bits: int, count: int) -> bytes:
    """One byte per row, 1 where the row's bit is set."""
    if not count:
        return b""
    return format(bits, "b").rjust(count, "0")[::-1].encode("ascii").translate(_BIT_BYTES)


def _flag_bits(flags: bytes) -> int:
    """The inverse of _selector: bit i set where byte i is nonzero."""
    return int(flags.translate(_FLAG_BITS)[::-1], 2) if flags else 0


def _lowest(bits: int) -> int | None:
    return (bits & -bits).bit_length() - 1 if bits else None


def _merge(rows: Iterable[int], unset: Iterable[Any], chosen: Iterable[Any]) -> Iterator[Any]:
    """Interleave two streams by a selector: the next of `chosen` where the row's byte is 1."""
    return map(next, map((iter(unset), iter(chosen)).__getitem__, rows))


_UNZIGZAG_BYTE = tuple(unzigzag(u) for u in range(0x80))


def _unzigzag(raws: array, start: int = 0) -> Iterator[int]:
    forms = islice(raws, start, None) if start else raws
    return map(_UNZIGZAG_BYTE.__getitem__ if raws.typecode == "B" else unzigzag, forms)


def _int_form(node: dict[str, Any], value: int) -> int:
    lo = node.get("min")
    return value - lo if lo is not None else zigzag(value)


def _check_int(node: dict[str, Any], v: Any, path: str) -> int:
    if not _is_int(v):
        _efail("type", path, "expected a safe integer")
    lo, hi = node.get("min"), node.get("max")
    if lo is not None and v < lo:
        _efail("range", path, f"{v} below declared min {lo}")
    if hi is not None and v > hi:
        _efail("range", path, f"{v} above declared max {hi}")
    return v


def _decode_int_value(node: dict[str, Any], raw: int, path: str) -> int:
    lo, hi = node.get("min"), node.get("max")
    value = raw + lo if lo is not None else unzigzag(raw)
    if value < INT_MIN or value > INT_MAX:
        _dfail("range", path, f"decoded integer {value} outside the v0 domain")
    if lo is not None and value < lo:
        _dfail("range", path, "below declared min")
    if hi is not None and value > hi:
        _dfail("range", path, "above declared max")
    return value


def _flatten_leaves(element: dict[str, Any]) -> list[tuple[tuple[str, ...], dict[str, Any]]] | None:
    out: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    def walk(node: dict[str, Any], segs: tuple[str, ...]) -> bool:
        fields = node.get("fields", [])
        if not fields:
            return False
        for f in fields:
            t = f["type"]
            if t["kind"] == "struct":
                if f.get("optional") or f.get("nullable"):
                    return False
                if not walk(t, segs + (f["name"],)):
                    return False
            elif t["kind"] in LEAF_KINDS:
                out.append((segs + (f["name"],), f))
            else:
                return False
        return True

    return out if walk(element, ()) else None


def _columnar_eligible(node: dict[str, Any]) -> bool:
    return node["element"].get("kind") == "struct" and _flatten_leaves(node["element"]) is not None


_Leaves = list[tuple[tuple[str, ...], dict[str, Any]]]


def _index_arrays(node: dict[str, Any], columnar: bool, out: dict[int, tuple[_Leaves | None, bool]]) -> None:
    """Per array node: its columnar leaves (None when row-encoded) and whether its element is zero-bit."""
    kind = node["kind"]
    if kind == "array":
        element = node["element"]
        if id(node) not in out:
            leaves = _flatten_leaves(element) if columnar and element.get("kind") == "struct" else None
            out[id(node)] = (leaves, not has_payload(element))
        _index_arrays(element, columnar, out)
    elif kind == "nullable":
        _index_arrays(node["inner"], columnar, out)
    elif kind == "struct":
        for f in node["fields"]:
            _index_arrays(f["type"], columnar, out)


_ABSENT: Any = object()


class _Values:
    """One column over its participating rows, held packed, typed or arithmetic until
    the whole body has decoded. `make` expands it, `const` is the value every row
    shares when one does, and `codes` maps a string column onto its dictionary for a
    derived column that reads it. A grammar lane's `outside` is the index of its first
    value out of bounds, which the column checks in row order."""

    __slots__ = ("make", "const", "codes", "outside")

    def __init__(
        self,
        make: Callable[[], Iterable[Any]],
        const: Any = _ABSENT,
        codes: Callable[[dict[str, int]], int | array] | None = None,
        outside: int | None = None,
    ) -> None:
        self.make = make
        self.const = const
        self.codes = codes
        self.outside = outside


def _constant(value: Any, count: int) -> _Values:
    return _Values(lambda: repeat(value, count), value, lambda lookup: lookup.get(value, 0))


_NONE = _Values(lambda: (), codes=lambda lookup: array("H"))


def _clone(value: Any) -> Any:
    if type(value) is dict:
        return {key: _clone(item) for key, item in value.items()}
    if type(value) is list:
        return [_clone(item) for item in value]
    return value


def _copies(value: Any, count: int) -> Iterable[Any]:
    if type(value) is dict or type(value) is list:
        return chain((value,), map(_clone, repeat(value, count - 1)))
    return repeat(value, count)


def _decimal_mantissa(v: float, pow10: int) -> float:
    # returns a float so callers can reject non-finite scaling before int conversion
    if v > 0:
        return math.floor(v * pow10 + 0.5) if math.isfinite(v * pow10) else math.inf
    if v < 0:
        return -math.floor(-v * pow10 + 0.5) if math.isfinite(v * pow10) else -math.inf
    return 0.0


def _decimal_scale(values: list[float]) -> int | None:
    for s in range(_MAX_SCALE + 1):
        pow10 = _POW10[s]
        ok = True
        for v in values:
            m = _decimal_mantissa(v, pow10)
            if not math.isfinite(m) or not (INT_MIN <= m <= INT_MAX) or m / pow10 != v:
                ok = False
                break
        if ok:
            return s
    return None


def _sig_bytes(x: int) -> int:
    return (x.bit_length() + 7) // 8


class _Ctx:
    __slots__ = (
        "max_depth",
        "max_items",
        "max_byte_length",
        "max_amplification",
        "columnar",
        "deflate",
        "inflate",
        "dicts",
        "codes",
        "grammars",
        "derivations",
        "arrays",
        "tables",
        "long_codes",
        "lane_bounds",
        "grammar_bytes",
        "renderers",
        "grammar_keys",
        "recodings",
        "derived_tables",
        "long_derived",
        "leaf_plans",
        "shapes",
        "column_counts",
        "entry_bytes",
        "derived_bytes",
        "longest_entry",
        "longest_derived",
        "uniform_entries",
        "uniform_derived",
        "enum_bytes",
    )

    def __init__(self, ir: dict[str, Any], limits: Limits, columnar: bool, deflate, inflate, profile=None) -> None:
        self.arrays: dict[int, tuple[_Leaves | None, bool]] = {}
        _index_arrays(ir, columnar, self.arrays)
        self.dicts: dict[int, list[str]] = {}
        self.codes: dict[int, dict[str, int]] = {}
        self.grammars: dict[int, list[dict[str, Any]]] = {}
        self.derivations: dict[int, dict[str, Any]] = {}
        if profile is not None:
            for column in profile["shared"]["columns"]:
                ordinal = column["leaf"]
                if "dict" in column:
                    self.dicts[ordinal] = column["dict"]
                    self.codes[ordinal] = {v: i + 1 for i, v in enumerate(column["dict"])}
                if "grammar" in column:
                    self.grammars[ordinal] = column["grammar"]
                if "derived" in column:
                    self.derivations[ordinal] = column["derived"]
        self.max_depth = limits.max_depth
        self.max_items = limits.max_items
        self.max_byte_length = limits.max_byte_length
        self.max_amplification = limits.max_amplification
        self.columnar = columnar
        self.deflate = deflate
        self.inflate = inflate
        # decode lookups, built once: a dictionary or derivation entry over the byte
        # limit fails only the rows that select it
        limit = limits.max_byte_length
        self.tables = {ordinal: (None, *entries) for ordinal, entries in self.dicts.items()}
        self.long_codes = {
            ordinal: frozenset(code for code, entry in enumerate(entries, 1) if len(entry.encode("utf-8")) > limit)
            for ordinal, entries in self.dicts.items()
        }
        self.lane_bounds = {
            ordinal: [{"min": 0, "max": _grammar_limit(token) - 1} for token in grammar if "num" in token]
            for ordinal, grammar in self.grammars.items()
        }
        self.grammar_bytes = {
            ordinal: sum(len(token["lit"].encode("utf-8")) if "lit" in token else token["num"]["len"] for token in grammar)
            for ordinal, grammar in self.grammars.items()
        }
        self.renderers = {ordinal: _grammar_renderer(grammar) for ordinal, grammar in self.grammars.items()}
        self.grammar_keys: dict[int, dict[Any, int]] = {}
        # per derived string column, its own dictionary's code for each derivation code,
        # built once a column is long enough to pay for it
        self.recodings: dict[int, dict[int, int]] = {}
        self.column_counts: dict[int, int] = {}
        columnar_leaves = [leaves for leaves, _zero_bit in self.arrays.values() if leaves is not None]
        self.leaf_plans = {
            id(leaves): [
                ("[]." + ".".join(segs), segs[-1], len(segs), bool(f.get("optional")), bool(f.get("nullable")), f["type"])
                for segs, f in leaves
            ]
            for leaves in columnar_leaves
        }
        self.shapes = {id(leaves): _shape(leaves, 0, 0, len(leaves)) for leaves in columnar_leaves}
        self.derived_tables = {
            ordinal: (None, *derivation["values"]) for ordinal, derivation in self.derivations.items()
        }
        self.long_derived = {
            ordinal: frozenset(
                code for code, value in enumerate(derivation["values"], 1) if len(value.encode("utf-8")) > limit
            )
            for ordinal, derivation in self.derivations.items()
        }
        # decoded byte lengths by code, for the byte budget; code 0 is an escape
        self.entry_bytes = {ordinal: (0, *map(_text_bytes, entries)) for ordinal, entries in self.dicts.items()}
        self.derived_bytes = {
            ordinal: (0, *map(_text_bytes, derivation["values"])) for ordinal, derivation in self.derivations.items()
        }
        self.longest_entry = {ordinal: max(sizes) for ordinal, sizes in self.entry_bytes.items()}
        self.longest_derived = {ordinal: max(sizes) for ordinal, sizes in self.derived_bytes.items()}
        # the dictionaries and derivations whose values all have one length
        self.uniform_entries = {ordinal for ordinal, sizes in self.entry_bytes.items() if len(set(sizes[1:])) == 1}
        self.uniform_derived = {ordinal for ordinal, sizes in self.derived_bytes.items() if len(set(sizes[1:])) == 1}
        self.enum_bytes: dict[int, tuple[int, ...]] = {}

    def column_count(self, node: dict[str, Any]) -> int:
        count = self.column_counts.get(id(node))
        if count is None:
            count = self.column_counts[id(node)] = column_count(node)
        return count

    def member_bytes(self, node: dict[str, Any]) -> tuple[int, ...]:
        sizes = self.enum_bytes.get(id(node))
        if sizes is None:
            sizes = self.enum_bytes[id(node)] = tuple(map(_text_bytes, node["members"]))
        return sizes

    def grammar_codes(self, ordinal: int, lookup: dict[str, int]) -> dict[Any, int]:
        """Dictionary codes keyed by the lanes of the entries that match the column's grammar."""
        keys = self.grammar_keys.get(ordinal)
        if keys is None:
            grammar = self.grammars[ordinal]
            single = len(self.lane_bounds[ordinal]) == 1
            keys = {}
            for value, code in lookup.items():
                lanes = _match_grammar(value, grammar)
                if lanes is not None:
                    keys[lanes[0] if single else tuple(lanes)] = code
            self.grammar_keys[ordinal] = keys
        return keys


def _encode_node(
    out: bytearray,
    node: dict[str, Any],
    value: Any,
    path: str,
    depth: int,
    ctx: _Ctx,
    budget: Budget,
    column: int = 0,
) -> None:
    if depth > ctx.max_depth:
        _efail("depth", path, f"nesting deeper than {ctx.max_depth}")
    kind = node["kind"]

    if kind == "bool":
        if type(value) is not bool:
            _efail("type", path, "expected boolean")
        out.append(1 if value else 0)
    elif kind == "int":
        write_uleb(out, _int_form(node, _check_int(node, value, path)))
    elif kind == "float64":
        out += struct.pack("<d", _canon_float(value, path))
    elif kind == "string":
        data = _utf8(value, path)
        if len(data) > ctx.max_byte_length:
            _efail("limit", path, f"string of {len(data)} bytes exceeds the codec limit")
        budget.charge_bytes(len(data), path, EncodeError)
        write_uleb(out, len(data))
        out += data
    elif kind == "bytes":
        if not isinstance(value, (bytes, bytearray)):
            _efail("type", path, "expected bytes")
        if len(value) > ctx.max_byte_length:
            _efail("limit", path, f"bytes of {len(value)} exceeds the codec limit")
        budget.charge_bytes(len(value), path, EncodeError)
        write_uleb(out, len(value))
        out += value
    elif kind == "literal":
        literal = node["value"]
        if not _literal_matches(literal, value):
            _efail("type", path, f"expected literal {literal!r}")
        if type(literal) is str:
            budget.charge_bytes(_text_bytes(literal), path, EncodeError)
    elif kind == "enum":
        if type(value) is not str:
            value = getattr(value, "value", value)
        try:
            index = node["members"].index(value)
        except (ValueError, TypeError):
            _efail("type", path, f"{value!r} is not an enum member")
        budget.charge_bytes(_text_bytes(value), path, EncodeError)
        write_uleb(out, index)
    elif kind == "nullable":
        if value is None:
            out.append(0)
        else:
            out.append(1)
            _encode_node(out, node["inner"], value, path, depth + 1, ctx, budget, column)
    elif kind == "array":
        leaves, zero_bit = ctx.arrays[id(node)]
        if leaves is not None:
            _encode_columnar(out, node, value, path, depth, ctx, budget, leaves, column)
            return
        if type(value) is not list:
            _efail("type", path, "expected array")
        if len(value) > ctx.max_items:
            _efail("limit", path, f"array of {len(value)} items exceeds the codec limit")
        length = node.get("length")
        if length is not None:
            if len(value) != length:
                _efail("type", path, f"fixed array expects {length} items, got {len(value)}")
        else:
            write_uleb(out, len(value))
        budget.charge(len(value), path, EncodeError)
        payload_start = len(out)
        for i, item in enumerate(value):
            _encode_node(out, node["element"], item, f"{path}[{i}]", depth + 1, ctx, budget, column)
        _check_amplification(len(value), len(out) - payload_start, not zero_bit, ctx, path)
    elif kind == "struct":
        if not isinstance(value, dict):
            _efail("type", path, "expected object")
        presence: list[bool] = []
        nulls: list[bool] = []
        for f in node["fields"]:
            v = value.get(f["name"])
            absent = f["name"] not in value
            if absent and not f.get("optional"):
                _efail("required", f"{path}.{f['name']}", "required field missing")
            if not absent and v is None and not f.get("nullable") and not _type_accepts_null(f["type"]):
                _efail("type", f"{path}.{f['name']}", "null for non-nullable field")
            if f.get("optional"):
                presence.append(not absent)
            if f.get("nullable"):
                nulls.append(not absent and v is None)
        write_bitmap(out, presence)
        write_bitmap(out, nulls)
        field_column = column
        for f in node["fields"]:
            base = field_column
            field_column += ctx.column_count(f["type"])
            if f["name"] not in value:
                continue
            v = value[f["name"]]
            if v is None and f.get("nullable"):
                continue
            _encode_node(out, f["type"], v, f"{path}.{f['name']}", depth + 1, ctx, budget, base)
    else:
        _efail("type", path, f"unknown kind {kind}")


def _encode_int_column(out: bytearray, node: dict[str, Any], values: list[int]) -> None:
    if not values:
        out.append(0)
        return
    forms = [_int_form(node, v) for v in values]
    diffs = [values[i] - values[i - 1] for i in range(1, len(values))]

    raw_cost = sum(uleb_len(f) for f in forms)
    delta_cost = uleb_len(forms[0]) + sum(uleb_len(zigzag(d)) for d in diffs)

    # frame of reference: subtract the column minimum, then spend only the bits the
    # remaining span needs rather than a whole number of bytes per value
    for_base = min(values)
    for_width = _bit_width(max(v - for_base for v in values))
    for_cost = (
        math.inf
        if for_width > _MAX_WIDTH
        else uleb_len(zigzag(for_base)) + 1 + _packed_bytes(len(values), for_width)
    )

    delta_for_cost = math.inf
    delta_base = 0
    delta_width = 0
    if diffs:
        delta_base = min(diffs)
        delta_width = _bit_width(max(d - delta_base for d in diffs))
        if delta_width <= _MAX_WIDTH:
            delta_for_cost = (
                uleb_len(forms[0])
                + uleb_len(zigzag(delta_base))
                + 1
                + _packed_bytes(len(diffs), delta_width)
            )

    pfor = None
    pfor_cost = math.inf
    if 0 < for_width <= _MAX_WIDTH:
        offsets = [value - for_base for value in values]
        for low_width in range(for_width):
            low_mask = (1 << low_width) - 1 if low_width else 0
            lows = [offset & low_mask for offset in offsets]
            high_parts = [offset >> low_width for offset in offsets]
            exceptions = [high != 0 for high in high_parts]
            highs = [high for high in high_parts if high != 0]
            high_width = _bit_width(max(highs, default=0))
            cost = (
                uleb_len(zigzag(for_base))
                + 2
                + _packed_bytes(len(values), 1)
                + _packed_bytes(len(values), low_width)
                + _packed_bytes(len(highs), high_width)
            )
            if cost < pfor_cost:
                pfor_cost = cost
                pfor = (low_width, high_width, exceptions, lows, highs)

    best = min(raw_cost, delta_cost, for_cost, delta_for_cost, pfor_cost)
    if best == raw_cost:
        out.append(0x00)
        for f in forms:
            write_uleb(out, f)
        return
    if best == delta_cost:
        out.append(0x01)
        write_uleb(out, forms[0])
        for d in diffs:
            write_uleb(out, zigzag(d))
        return
    if best == for_cost:
        out.append(0x02)
        write_uleb(out, zigzag(for_base))
        out.append(for_width)
        _pack_bits(out, [v - for_base for v in values], for_width)
        return
    if best == delta_for_cost:
        out.append(0x03)
        write_uleb(out, forms[0])
        write_uleb(out, zigzag(delta_base))
        out.append(delta_width)
        _pack_bits(out, [d - delta_base for d in diffs], delta_width)
        return
    low_width, high_width, exceptions, lows, highs = pfor
    out.append(0x04)
    write_uleb(out, zigzag(for_base))
    out.append(low_width)
    out.append(high_width)
    write_bitmap(out, exceptions)
    _pack_bits(out, lows, low_width)
    _pack_bits(out, highs, high_width)


def _encode_float_column(out: bytearray, values: list[Any], path: str) -> None:
    if not values:
        out.append(0)
        return
    canon = [_canon_float(v, f"{path}[{i}]") for i, v in enumerate(values)]
    bits = [_float_bits(v) for v in canon]

    xors = [bits[i] ^ bits[i - 1] for i in range(1, len(bits))]
    xor_cost = 8 + sum(1 + _sig_bytes(x) for x in xors)
    raw_cost = 8 * len(bits)

    scale = _decimal_scale(canon)
    scaled_delta_cost = scaled_raw_cost = math.inf
    mantissas: list[int] = []
    if scale is not None:
        pow10 = _POW10[scale]
        mantissas = [int(_decimal_mantissa(v, pow10)) for v in canon]
        scaled_raw_cost = 1 + sum(uleb_len(zigzag(m)) for m in mantissas)
        scaled_delta_cost = 1 + uleb_len(zigzag(mantissas[0])) + sum(
            uleb_len(zigzag(mantissas[i] - mantissas[i - 1])) for i in range(1, len(mantissas))
        )

    best = min(raw_cost, xor_cost, scaled_delta_cost, scaled_raw_cost)
    if best == raw_cost:
        out.append(0)
        for b in bits:
            out += struct.pack("<Q", b)
    elif best == xor_cost:
        out.append(1)
        out += struct.pack("<Q", bits[0])
        for x in xors:
            n = _sig_bytes(x)
            out.append(n)
            out += x.to_bytes(n, "little")
    elif best == scaled_delta_cost:
        out.append(2)
        out.append(scale)
        write_uleb(out, zigzag(mantissas[0]))
        for i in range(1, len(mantissas)):
            write_uleb(out, zigzag(mantissas[i] - mantissas[i - 1]))
    else:
        out.append(3)
        out.append(scale)
        for m in mantissas:
            write_uleb(out, zigzag(m))


_GRAMMAR_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _grammar_limit(token: dict[str, Any]) -> int:
    num = token["num"]
    return num["base"] ** num["len"]


def _grammar_digit(char: str, num: dict[str, Any]) -> int:
    code = ord(char)
    if 0x30 <= code <= 0x39:
        digit = code - 0x30
    elif num["case"] == "lower" and 0x61 <= code <= 0x7A:
        digit = code - 0x61 + 10
    elif num["case"] == "upper" and 0x41 <= code <= 0x5A:
        digit = code - 0x41 + 10
    else:
        return -1
    return digit if digit < num["base"] else -1


def _match_grammar(value: str, grammar: list[dict[str, Any]]) -> list[int] | None:
    """Exact ASCII grammar match and lane parse; None means literal escape."""
    offset = 0
    lanes: list[int] = []
    for token in grammar:
        if "lit" in token:
            literal = token["lit"]
            if not value.startswith(literal, offset):
                return None
            offset += len(literal)
            continue
        num = token["num"]
        end = offset + num["len"]
        if end > len(value):
            return None
        lane = 0
        for char in value[offset:end]:
            digit = _grammar_digit(char, num)
            if digit < 0:
                return None
            lane = lane * num["base"] + digit
        lanes.append(lane)
        offset = end
    return lanes if offset == len(value) else None


def _render_grammar(grammar: list[dict[str, Any]], lanes: list[int]) -> str:
    out = []
    lane_index = 0
    for token in grammar:
        if "lit" in token:
            out.append(token["lit"])
            continue
        num = token["num"]
        value = lanes[lane_index]
        lane_index += 1
        if value == 0:
            digits = "0"
        else:
            rendered = []
            while value:
                rendered.append(_GRAMMAR_DIGITS[value % num["base"]])
                value //= num["base"]
            digits = "".join(reversed(rendered))
        if num["case"] == "upper":
            digits = digits.upper()
        out.append(digits.rjust(num["len"], "0"))
    return "".join(out)


def _grammar_renderer(grammar: list[dict[str, Any]]) -> Callable[[Any], str]:
    """Render a matched value from its lane key: the lane value itself for a one-lane
    grammar, else the tuple of lane values."""
    lanes = sum("num" in token for token in grammar)
    parts = []
    for token in grammar:
        if "lit" in token:
            parts.append(token["lit"].replace("%", "%%"))
            continue
        num = token["num"]
        if num["base"] == 36:
            if lanes == 1:
                return lambda key: _render_grammar(grammar, [key])
            return lambda key: _render_grammar(grammar, list(key))
        spec = "d" if num["base"] == 10 else "x" if num["case"] == "lower" else "X"
        parts.append(f"%0{num['len']}{spec}")
    return "".join(parts).__mod__


def _escape_cost(encoded: list[bytes], escaped: list[bool]) -> int:
    return sum(
        uleb_len(len(value)) + len(value)
        for value, is_escaped in zip(encoded, escaped)
        if is_escaped
    )


def _write_escaped(out: bytearray, encoded: list[bytes], escaped: list[bool]) -> None:
    for value, is_escaped in zip(encoded, escaped):
        if not is_escaped:
            continue
        write_uleb(out, len(value))
        out += value


def _write_escape_header(out: bytearray, escaped: list[bool], count: int) -> None:
    write_uleb(out, count)
    if 0 < count < len(escaped):
        write_bitmap(out, escaped)


def _encode_string_column(
    out: bytearray,
    values: list[Any],
    slots: list[int],
    source_value,
    path: str,
    ctx: _Ctx,
    budget: Budget,
    ordinal: int,
) -> None:
    if not values:
        out.append(0)
        return
    encoded = []
    for i, value in enumerate(values):
        data = _utf8(value, f"{path}[{i}]")
        if len(data) > ctx.max_byte_length:
            _efail(
                "limit",
                f"{path}[{i}]",
                f"string of {len(data)} bytes exceeds the codec limit",
            )
        budget.charge_bytes(len(data), f"{path}[{i}]", EncodeError)
        encoded.append(data)
    plain_cost = sum(uleb_len(len(b)) + len(b) for b in encoded)

    codes = None
    dict_cost = math.inf
    dict_width = 0
    lookup = ctx.codes.get(ordinal)
    if lookup is not None:
        codes = [lookup.get(v, 0) for v in values]
        dict_width = _bit_width(max(codes, default=0))
        dict_escaped = [code == 0 for code in codes]
        dict_cost = 1 + _packed_bytes(len(codes), dict_width) + _escape_cost(encoded, dict_escaped)

    packed = None
    packed_cost = math.inf
    total = sum(len(value) for value in encoded)
    # A packed column's aggregate and blob lengths are decoder-limited even when
    # every individual string is small. A disqualified aggregate never reaches
    # the hook at all — custom hooks must not observe unencodable input.
    if ctx.deflate is not None and ctx.inflate is not None and total <= ctx.max_byte_length:
        candidate = ctx.deflate(b"".join(encoded))
        if len(candidate) <= ctx.max_byte_length:
            packed = candidate
            packed_cost = (
                sum(uleb_len(len(value)) for value in encoded)
                + uleb_len(len(packed))
                + len(packed)
            )

    grammar = ctx.grammars.get(ordinal)
    grammar_cost = math.inf
    grammar_escaped = None
    grammar_lanes = None
    if grammar is not None:
        parsed = [_match_grammar(value, grammar) for value in values]
        grammar_escaped = [row is None for row in parsed]
        escape_count = sum(grammar_escaped)
        numeric = [token for token in grammar if "num" in token]
        grammar_lanes = [[] for _ in numeric]
        for row in parsed:
            if row is None:
                continue
            for lane_index, lane_value in enumerate(row):
                grammar_lanes[lane_index].append(lane_value)
        grammar_cost = uleb_len(escape_count)
        if 0 < escape_count < len(values):
            grammar_cost += _packed_bytes(len(values), 1)
        for token, lane in zip(numeric, grammar_lanes):
            lane_bytes = bytearray()
            _encode_int_column(lane_bytes, {"min": 0, "max": _grammar_limit(token) - 1}, lane)
            grammar_cost += len(lane_bytes)
        grammar_cost += _escape_cost(encoded, grammar_escaped)

    derivation = ctx.derivations.get(ordinal)
    derived_cost = math.inf
    derived_escaped = None
    if derivation is not None:
        source_lookup = ctx.codes[derivation["source"]]
        derived_escaped = []
        for value, row in zip(values, slots):
            source = source_value(derivation["source"], row)
            code = source_lookup.get(source) if type(source) is str else None
            derived_escaped.append(
                code is None or derivation["values"][code - 1] != value
            )
        escape_count = sum(derived_escaped)
        derived_cost = uleb_len(escape_count)
        if 0 < escape_count < len(values):
            derived_cost += _packed_bytes(len(values), 1)
        derived_cost += _escape_cost(encoded, derived_escaped)

    costs = [plain_cost, dict_cost, packed_cost, grammar_cost, derived_cost]
    mode = costs.index(min(costs))
    out.append(mode)

    if mode == 0x00:
        _write_escaped(out, encoded, [True] * len(encoded))
        return
    if mode == 0x01:
        out.append(dict_width)
        _pack_bits(out, codes, dict_width)
        _write_escaped(out, encoded, [code == 0 for code in codes])
        return
    if mode == 0x02:
        for b in encoded:
            write_uleb(out, len(b))
        write_uleb(out, len(packed))
        out += packed
        return
    if mode == 0x03:
        escape_count = sum(grammar_escaped)
        _write_escape_header(out, grammar_escaped, escape_count)
        numeric = [token for token in grammar if "num" in token]
        for token, lane in zip(numeric, grammar_lanes):
            _encode_int_column(out, {"min": 0, "max": _grammar_limit(token) - 1}, lane)
        _write_escaped(out, encoded, grammar_escaped)
        return
    escape_count = sum(derived_escaped)
    _write_escape_header(out, derived_escaped, escape_count)
    _write_escaped(out, encoded, derived_escaped)


def _encode_enum_column(
    out: bytearray, node: dict[str, Any], values: list[Any], path: str, budget: Budget
) -> None:
    indices = []
    for i, value in enumerate(values):
        if type(value) is not str:
            value = getattr(value, "value", value)
        try:
            indices.append(node["members"].index(value))
        except (ValueError, TypeError):
            _efail("type", f"{path}[{i}]", f"{value!r} is not an enum member")
        budget.charge_bytes(_text_bytes(value), f"{path}[{i}]", EncodeError)
    _pack_bits(out, indices, _bit_width(len(node["members"]) - 1))


def _encode_columnar(
    out: bytearray,
    node: dict[str, Any],
    value: Any,
    path: str,
    depth: int,
    ctx: _Ctx,
    budget: Budget,
    leaves: _Leaves,
    ordinal_base: int = 0,
) -> None:
    if type(value) is not list:
        _efail("type", path, "expected array")
    if len(value) > ctx.max_items:
        _efail("limit", path, f"array of {len(value)} items exceeds the codec limit")
    length = node.get("length")
    if length is not None:
        if len(value) != length:
            _efail("type", path, f"fixed array expects {length} items, got {len(value)}")
    else:
        write_uleb(out, len(value))
    budget.charge(len(value), path, EncodeError)
    payload_start = len(out)

    rows: list[dict[str, Any]] = []
    for i, row in enumerate(value):
        if not isinstance(row, dict):
            _efail("type", f"{path}[{i}]", "expected object")
        rows.append(row)

    def container(row: dict[str, Any], segs: tuple[str, ...], i: int) -> dict[str, Any]:
        obj = row
        for depth_index, seg in enumerate(segs[:-1]):
            nxt = obj.get(seg)
            if not isinstance(nxt, dict):
                code = "required" if seg not in obj else "type"
                _efail(
                    code,
                    f"{path}[{i}].{'.'.join(segs[: depth_index + 1])}",
                    "expected object",
                )
            obj = nxt
        return obj

    inputs = []
    for segs, field in leaves:
        dotted = ".".join(segs)
        leaf = segs[-1]
        holders = [container(row, segs, i) for i, row in enumerate(rows)]
        values = [holder.get(leaf) for holder in holders]
        states = []
        for i, holder in enumerate(holders):
            absent = leaf not in holder
            v = values[i]
            if absent and not field.get("optional"):
                _efail("required", f"{path}[{i}].{dotted}", "required field missing")
            if not absent and v is None and not field.get("nullable") and not _type_accepts_null(field["type"]):
                _efail("type", f"{path}[{i}].{dotted}", "null for non-nullable field")
            states.append((not absent, not absent and v is None))

        slots = []
        participating = []
        for row_index, state in enumerate(states):
            if not state[0] or (state[1] and field.get("nullable")):
                continue
            slots.append(row_index)
            participating.append(values[row_index])
        inputs.append(
            {
                "values": values,
                "states": states,
                "slots": slots,
                "participating": participating,
            }
        )

    def source_value(ordinal: int, row: int) -> Any:
        local = ordinal - ordinal_base
        if local < 0 or local >= len(inputs):
            return None
        field = leaves[local][1]
        entry = inputs[local]
        present, is_null = entry["states"][row]
        if not present or (is_null and field.get("nullable")):
            return None
        return entry["values"][row]

    for leaf_index, (segs, field) in enumerate(leaves):
        dotted = ".".join(segs)
        field_path = f"{path}[].{dotted}"
        entry = inputs[leaf_index]
        states = entry["states"]
        slots = entry["slots"]
        participating = entry["participating"]
        if field.get("optional"):
            write_bitmap(out, [s[0] for s in states])
        if field.get("nullable"):
            write_bitmap(out, [s[0] and s[1] for s in states])

        if rows and depth + len(segs) > ctx.max_depth:
            _efail("depth", f"{path}[].{dotted}", f"nesting deeper than {ctx.max_depth}")
        if participating and depth + 1 + len(segs) > ctx.max_depth:
            _efail("depth", f"{path}[].{dotted}", f"nesting deeper than {ctx.max_depth}")

        t = field["type"]
        kind = t["kind"]
        if kind == "int":
            _encode_int_column(out, t, [_check_int(t, v, f"{field_path}[{i}]") for i, v in enumerate(participating)])
        elif kind == "float64":
            _encode_float_column(out, participating, field_path)
        elif kind == "bool":
            for i, v in enumerate(participating):
                if type(v) is not bool:
                    _efail("type", f"{field_path}[{i}]", "expected boolean")
            write_bitmap(out, list(participating))
        elif kind == "string":
            _encode_string_column(
                out,
                participating,
                slots,
                source_value,
                field_path,
                ctx,
                budget,
                ordinal_base + leaf_index,
            )
        elif kind == "enum":
            _encode_enum_column(out, t, participating, field_path, budget)
        else:
            for i, v in enumerate(participating):
                _encode_node(out, t, v, f"{field_path}[{i}]", depth + 2, ctx, budget)

    _check_amplification(len(rows), len(out) - payload_start, False, ctx, path)


def _decode_node(r: Reader, node: dict[str, Any], path: str, depth: int, ctx: _Ctx, column: int = 0) -> Any:
    if depth > ctx.max_depth:
        _dfail("depth", path, f"nesting deeper than {ctx.max_depth}")
    kind = node["kind"]

    if kind == "bool":
        b = r.u8()
        if b > 1:
            _dfail("marker", path, f"invalid bool byte 0x{b:x}")
        return b == 1
    if kind == "int":
        return _decode_int_value(node, read_uleb(r), path)
    if kind == "float64":
        raw = r.take(8)
        bits = struct.unpack("<Q", raw)[0]
        if bits == _NEG_ZERO_BITS:
            _dfail("float", path, "negative-zero bit pattern")
        value = _bits_float(bits)
        if not math.isfinite(value):
            _dfail("float", path, "non-finite float64")
        return value
    if kind == "string":
        n = read_uleb(r)
        if n > r.limits.max_byte_length:
            _dfail("limit", path, "string length exceeds limit")
        r.budget.charge_bytes(n, path, DecodeError)
        data = r.take(n)
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            _dfail("utf8", path, "invalid UTF-8")
    if kind == "bytes":
        n = read_uleb(r)
        if n > r.limits.max_byte_length:
            _dfail("limit", path, "bytes length exceeds limit")
        r.budget.charge_bytes(n, path, DecodeError)
        return bytes(r.take(n))
    if kind == "literal":
        literal = node["value"]
        if type(literal) is str:
            r.budget.charge_bytes(_text_bytes(literal), path, DecodeError)
        return literal
    if kind == "enum":
        index = read_uleb(r)
        if index >= len(node["members"]):
            _dfail("range", path, f"enum index {index} out of range")
        member = node["members"][index]
        r.budget.charge_bytes(_text_bytes(member), path, DecodeError)
        return member
    if kind == "nullable":
        marker = r.u8()
        if marker == 0:
            return None
        if marker != 1:
            _dfail("marker", path, f"invalid nullable marker 0x{marker:x}")
        return _decode_node(r, node["inner"], path, depth + 1, ctx, column)
    if kind == "array":
        leaves, zero_bit = ctx.arrays[id(node)]
        if leaves is not None:
            return _decode_columnar(r, node, leaves, path, depth, ctx, column)
        length = node.get("length")
        if length is None:
            length = read_uleb(r)
        if length > r.limits.max_items:
            _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
        _bound_by_input(r, length, zero_bit, path)
        budget = r.budget
        budget.charge(length, path, DecodeError)
        element = node["element"]
        if zero_bit:
            if not length:
                return []
            # every element decodes from the same zero bits to an equal value, so one
            # decode stands for all and charges the budgets for each
            counted, decoded = budget.total, budget.bytes
            first = _decode_node(r, element, f"{path}[0]", depth + 1, ctx, column)
            budget.charge((length - 1) * (budget.total - counted), path, DecodeError)
            budget.charge_bytes((length - 1) * (budget.bytes - decoded), path, DecodeError)
            items: list[Any] = []
            r.deferred.append((items, lambda: _copies(first, length)))
            return items
        return [_decode_node(r, element, f"{path}[{i}]", depth + 1, ctx, column) for i in range(length)]
    if kind == "struct":
        optional = [f for f in node["fields"] if f.get("optional")]
        nullable = [f for f in node["fields"] if f.get("nullable")]
        presence = read_bitmap(r, len(optional), path)
        nulls = read_bitmap(r, len(nullable), path)
        pi = ni = 0
        out: dict[str, Any] = {}
        field_column = column
        for f in node["fields"]:
            base = field_column
            field_column += ctx.column_count(f["type"])
            present = True
            if f.get("optional"):
                present = presence[pi]
                pi += 1
            is_null = False
            if f.get("nullable"):
                is_null = nulls[ni]
                ni += 1
            if not present:
                if is_null:
                    _dfail("bitmap", f"{path}.{f['name']}", "null bit set for absent field")
                continue
            if is_null:
                out[f["name"]] = None
                continue
            out[f["name"]] = _decode_node(r, f["type"], f"{path}.{f['name']}", depth + 1, ctx, base)
        return out
    _dfail("marker", path, f"unknown kind {kind}")


def _decode_int_column(r: Reader, node: dict[str, Any], count: int, path: str, lane: bool = False) -> _Values:
    """A column's values, each checked against the node's bounds in row order with its
    structure; a grammar lane reads only its structure here and leaves its bounds to the
    column, which checks them value by value."""
    mode = r.u8()
    if mode > 4:
        _dfail("marker", path, f"invalid int column mode 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return _NONE
    lo = node.get("min")
    if mode <= 0x01:
        raws, err = read_ulebs(r, count)
        if lane and err is not None:
            raise err
        values = array("q")
        if raws:
            if mode == 0x00:
                make = (lambda: map(add, raws, repeat(lo))) if lo is not None else (lambda: _unzigzag(raws))
            else:
                first = raws[0] + lo if lo is not None else unzigzag(raws[0])
                make = lambda: accumulate(_unzigzag(raws, 1), initial=first)
            if lane:
                return _lane((lambda: raws) if mode == 0x00 else make, node)
            values = _checked_ints(make, node, path)
        if err is not None:
            raise err
        return _Values(lambda: values)
    if mode == 0x02:
        base = unzigzag(read_uleb(r))
        width = r.u8()
        return _framed(_unpack_bits(r, count, width, path), base, count, node, path, lane)
    if mode == 0x03:
        if count < 2:
            _dfail("marker", path, "delta frame requires at least two values")
        raw_first = read_uleb(r)
        first = raw_first + lo if lo is not None else unzigzag(raw_first)
        base = unzigzag(read_uleb(r))
        width = r.u8()
        packed = _unpack_bits(r, count - 1, width, path)
        if packed is None:
            return _arithmetic(first, base, count, node, path, lane)
        deltas: array = packed
        make = lambda: accumulate(map(add, deltas, repeat(base)), initial=first)
        if lane:
            return _lane(make, node)
        values = _checked_ints(make, node, path)
        return _Values(lambda: values)
    base = unzigzag(read_uleb(r))
    low_width = r.u8()
    high_width = r.u8()
    if low_width > 55:
        _dfail("marker", path, f"patched frame low width {low_width} exceeds 55")
    if high_width < 1 or low_width + high_width > _MAX_WIDTH:
        _dfail(
            "marker",
            path,
            f"invalid patched frame widths L={low_width}, H={high_width}",
        )
    exceptions = read_bits(r, count, path)
    lows = _unpack_bits(r, count, low_width, path)
    patched = exceptions.bit_count()
    highs = _unpack_bits(r, patched, high_width, path)
    if highs is None or not patched:
        return _framed(lows, base, count, node, path, lane)
    high_parts: array = highs
    rows = _selector(exceptions, count)

    def patched_values() -> Iterator[int]:
        offsets = map(lshift, _merge(rows, repeat(0), high_parts), repeat(low_width))
        if lows is not None:
            offsets = map(add, lows, offsets)
        return map(add, offsets, repeat(base))

    if 0 in high_parts:
        row = next(islice(compress(itertools.count(), rows), high_parts.index(0), None))
        index = None if lane else _first_outside(lambda: islice(patched_values(), row), *_int_bounds(node))
        if index is None:
            _dfail("bitmap", f"{path}[{row}]", "patched frame exception has a zero high part")
        _range_fail(node, path, index, next(islice(patched_values(), index, None)))
    if lane:
        return _lane(patched_values, node)
    values = _checked_ints(patched_values, node, path)
    return _Values(lambda: values)


def _int_bounds(node: dict[str, Any]) -> tuple[int, int]:
    lo, hi = node.get("min"), node.get("max")
    return (
        INT_MIN if lo is None else max(INT_MIN, lo),
        INT_MAX if hi is None else min(INT_MAX, hi),
    )


def _range_error(node: dict[str, Any], path: str, index: int, value: int) -> DecodeError:
    if value < INT_MIN or value > INT_MAX:
        return DecodeError("range", f"{path}[{index}]: decoded integer outside the v0 domain")
    if node.get("min") is not None and value < node["min"]:
        return DecodeError("range", f"{path}[{index}]: below declared min")
    return DecodeError("range", f"{path}[{index}]: above declared max")


def _range_fail(node: dict[str, Any], path: str, index: int, value: int) -> NoReturn:
    raise _range_error(node, path, index, value)


def _first_outside(make: Callable[[], Iterable[int]], floor: int, ceil: int) -> int | None:
    below = next(compress(itertools.count(), map(floor.__gt__, make())), None)
    above = next(compress(itertools.count(), map(ceil.__lt__, make())), None)
    if below is None or (above is not None and above < below):
        return above
    return below


def _checked_ints(make: Callable[[], Iterable[int]], node: dict[str, Any], path: str) -> array:
    """The values as an int64 array, once every one lies in the domain and the
    declared bounds; otherwise the first that does not fails."""
    floor, ceil = _int_bounds(node)
    try:
        values: array | None = array("q", make())
    except OverflowError:
        values = None
    if values is None or (values and (min(values) < floor or max(values) > ceil)):
        index = _first_outside(make, floor, ceil)
        assert index is not None
        _range_fail(node, path, index, next(islice(make(), index, None)))
    return values


def _framed(packed: array | None, base: int, count: int, node: dict[str, Any], path: str, lane: bool) -> _Values:
    floor, ceil = _int_bounds(node)
    if lane:
        if packed is None:
            values = _constant(base, count)
            values.outside = None if floor <= base <= ceil else 0
            return values
        offsets: array = packed
        make = (lambda: offsets) if base == 0 else (lambda: map(add, offsets, repeat(base)))
        outside = None
        if base + min(offsets) < floor or base + max(offsets) > ceil:
            outside = _first_outside(make, floor, ceil)
        return _Values(make, outside=outside)
    if packed is None:
        if not floor <= base <= ceil:
            _range_fail(node, path, 0, base)
        return _constant(base, count)
    if base + min(packed) < floor or base + max(packed) > ceil:
        index = _first_outside(lambda: map(add, packed, repeat(base)), floor, ceil)
        assert index is not None
        _range_fail(node, path, index, base + packed[index])
    if base == 0:
        return _Values(lambda: packed)
    return _Values(lambda: map(add, packed, repeat(base)))


def _arithmetic(first: int, step: int, count: int, node: dict[str, Any], path: str, lane: bool) -> _Values:
    """A width-zero delta frame: the values run from first by step."""
    index = _arithmetic_outside(first, step, count, *_int_bounds(node))
    if index is not None and not lane:
        _range_fail(node, path, index, first + index * step)
    values = _constant(first, count) if step == 0 else _Values(lambda: range(first, first + count * step, step))
    values.outside = index
    return values


def _arithmetic_outside(first: int, step: int, count: int, floor: int, ceil: int) -> int | None:
    """The ends of a progression bound it, so its first value out of bounds is a division away."""
    if not floor <= first <= ceil:
        return 0
    last = first + (count - 1) * step
    if last > ceil:
        return (ceil - first) // step + 1
    if last < floor:
        return (first - floor) // -step + 1
    return None


def _lane(make: Callable[[], Iterable[int]], node: dict[str, Any]) -> _Values:
    """A grammar lane's values, typed where they fit, and its first value out of bounds."""
    floor, ceil = _int_bounds(node)
    run = make()
    try:
        values = run if type(run) is array else array("q", run)
    except OverflowError:
        return _Values(make, outside=_first_outside(make, floor, ceil))
    outside = None
    if values and (min(values) < floor or max(values) > ceil):
        outside = _first_outside(lambda: values, floor, ceil)
    return _Values(lambda: values, outside=outside)


def _decode_float_column(r: Reader, count: int, path: str) -> _Values:
    mode = r.u8()
    if mode > 3:
        _dfail("marker", path, f"invalid float column mode 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return _NONE

    if mode >= 2:
        scale = r.u8()
        if scale > _MAX_SCALE:
            _dfail("marker", path, f"decimal scale {scale} exceeds {_MAX_SCALE}")
        pow10 = _POW10[scale]
        raws, err = read_ulebs(r, count)
        mantissas = array("q")
        if raws:
            make = (lambda: _unzigzag(raws)) if mode == 3 else (lambda: accumulate(_unzigzag(raws)))
            try:
                mantissas = array("q", make())
                inside = min(mantissas) >= INT_MIN and max(mantissas) <= INT_MAX
            except OverflowError:
                inside = False
            if not inside:
                index = _first_outside(make, INT_MIN, INT_MAX)
                _dfail("range", f"{path}[{index}]", "decimal mantissa outside the v0 domain")
        if err is not None:
            raise err
        return _Values(lambda: map(truediv, mantissas, repeat(pow10)))

    bits = array("Q")
    if mode == 0:
        available = min(count, r.remaining() // 8)
        bits.frombytes(r.take(8 * available))
        if _BIG_ENDIAN:
            bits.byteswap()
        bad_zero = bits.index(_NEG_ZERO_BITS) if _NEG_ZERO_BITS in bits else None
        bad_exponent = next(compress(itertools.count(), map(_EXPONENT.__eq__, map(and_, bits, repeat(_EXPONENT)))), None)
        if bad_zero is not None and (bad_exponent is None or bad_zero < bad_exponent):
            _dfail("float", f"{path}[{bad_zero}]", "negative-zero bit pattern")
        if bad_exponent is not None:
            _dfail("float", f"{path}[{bad_exponent}]", "non-finite float64")
        if available < count:
            raise DecodeError("truncated", "unexpected end of input")
    else:
        prev = int.from_bytes(r.take(8), "little")
        buf = r.buf
        pos = r.pos
        end = len(buf)
        append = bits.append
        for i in range(count):
            if i:
                if pos >= end:
                    raise DecodeError("truncated", "unexpected end of input")
                n = buf[pos]
                pos += 1
                if n:
                    if n > 8:
                        _dfail("marker", f"{path}[{i}]", f"xor length {n} exceeds 8")
                    if pos + n > end:
                        raise DecodeError("truncated", "unexpected end of input")
                    x = int.from_bytes(buf[pos : pos + n], "little")
                    pos += n
                    if not x >> (8 * n - 8):
                        _dfail("float", f"{path}[{i}]", "non-minimal xor encoding")
                    prev ^= x
            if prev == _NEG_ZERO_BITS:
                _dfail("float", f"{path}[{i}]", "negative-zero bit pattern")
            if prev & _EXPONENT == _EXPONENT:
                _dfail("float", f"{path}[{i}]", "non-finite float64")
            append(prev)
        r.pos = pos
    floats = array("d")
    floats.frombytes(bits.tobytes())
    return _Values(lambda: floats)


# a value's own failure: its participating row, whether its length is charged to the
# byte budget before the error, and the error
_Failure = tuple[int, bool, DecodeError]


def _read_slices(
    r: Reader, count: int, path: str, what: str, at: Callable[[int], int] | None = None
) -> tuple[array, array, _Failure | None, int]:
    """Offsets of up to `count` length-prefixed values, stopping at the first
    malformed one, whose failure is returned for the caller to order, with the
    declared length of a value whose bytes run out."""
    buf = r.buf
    pos = r.pos
    end = len(buf)
    limit = r.limits.max_byte_length
    offset = _UINT[4] if end >> 32 == 0 else "Q"
    starts = array(offset)
    ends = array(offset)
    for j in range(count):
        if pos < end and buf[pos] < 0x80:
            n = buf[pos]
            pos += 1
        else:
            try:
                n, pos = uleb_at(buf, pos)
            except DecodeError as err:
                return starts, ends, (j, False, err), 0
        if n > limit:
            index = at(j) if at else j
            return starts, ends, (j, False, DecodeError("limit", f"{path}[{index}]: {what} length exceeds limit")), 0
        if pos + n > end:
            return starts, ends, (j, True, DecodeError("truncated", "unexpected end of input")), n
        starts.append(pos)
        pos += n
        ends.append(pos)
    r.pos = pos
    return starts, ends, None, 0


def _invalid_utf8(buf: bytes, starts: array, ends: array, count: int) -> int | None:
    """The first of the first `count` slices that is not strict UTF-8. One decode
    covers them all: the length prefixes between them are ASCII once the multi-byte
    ones are blanked, and an ASCII byte never sits inside a UTF-8 sequence."""
    if not count:
        return None
    lo = starts[0]
    span: bytes | bytearray = buf[lo : ends[count - 1]]
    if span.isascii():
        return None
    gaps = map(sub, islice(starts, 1, count), ends)
    wide = list(compress(itertools.count(1), map((1).__lt__, gaps)))
    if wide:
        span = bytearray(span)
        for j in wide:
            span[ends[j - 1] - lo : starts[j] - lo] = bytes(starts[j] - ends[j - 1])
    try:
        span.decode("utf-8")
    except UnicodeDecodeError as err:
        return bisect_right(starts, lo + err.start, 0, count) - 1
    return None


def _escapes(
    r: Reader, count: int, path: str, at: Callable[[int], int] | None = None, what: str = "string"
) -> tuple[array, array, _Failure | None, Callable[[], Iterable[int]]]:
    """Up to `count` length-prefixed values in row order: their offsets, the first
    that fails at its participating row, and their lengths as far as they were read."""
    if not count:
        none = array(_UINT[4])
        return none, none, None, tuple
    starts, ends, failure, pending = _read_slices(r, count, path, what, at)
    if what == "string":
        bad = _invalid_utf8(r.buf, starts, ends, len(starts))
        if bad is not None:
            failure = (bad, True, DecodeError("utf8", f"{path}[{at(bad) if at else bad}]: invalid UTF-8"))
    if failure is not None and at is not None:
        failure = (at(failure[0]), failure[1], failure[2])
    return starts, ends, failure, lambda: chain(map(sub, ends, starts), (pending,))


_SUM_NOW = 1024


def _settle(
    r: Reader,
    make: Callable[[], Iterable[int]],
    failure: _Failure | None,
    path: str,
    bound: int | None = None,
    total: Callable[[], int] | None = None,
) -> None:
    """Charge a column's value lengths, given in participating-row order, as if value
    by value: the first value whose own checks fail or whose charge passes the byte
    budget decides the error. A column with no failure whose `bound` on the sum of its
    lengths fits defers the exact sum, `total` or else the lengths summed."""
    budget = r.budget
    exact = total or (lambda: sum(make()))
    if failure is None and bound is not None:
        # a small column is summed at once: its rows are no more than its bound, unless
        # all its values share one length and its sum is a product
        if bound <= _SUM_NOW and bound <= budget.byte_cap - budget.bytes - budget.owed:
            budget.bytes += exact()
            return
        if bound > _SUM_NOW and budget.defer_bytes(bound, exact):
            return
    budget.settle()
    remaining = budget.byte_cap - budget.bytes
    lengths = make
    if failure is None:
        charge = exact()
        if charge <= remaining:
            budget.bytes += charge
            return
    else:
        stop = failure[0] + failure[1]
        lengths = lambda: islice(make(), stop)
    index = next(compress(itertools.count(), map(remaining.__lt__, accumulate(lengths()))), None)
    if index is not None:
        _dfail("limit", f"{path}[{index}]", f"decoded bytes exceed the byte budget of {budget.byte_cap}")
    assert failure is not None
    raise failure[2]


def _settle_uniform(r: Reader, length: int, count: int, failure: _Failure | None, path: str) -> None:
    """_settle for a column whose every value is `length` bytes long."""
    budget = r.budget
    rows = count if failure is None else failure[0] + failure[1]
    if length * rows > budget.byte_cap - budget.bytes - budget.owed:
        budget.settle()
        remaining = budget.byte_cap - budget.bytes
        if length * rows > remaining:
            _dfail("limit", f"{path}[{remaining // length}]", f"decoded bytes exceed the byte budget of {budget.byte_cap}")
    if failure is not None:
        raise failure[2]
    budget.bytes += length * count


def _span(starts: array, ends: array) -> int:
    """At least the total length of contiguous slices read in order."""
    return ends[-1] - starts[0] if starts else 0


def _literals(r: Reader, count: int, path: str, what: str = "string") -> tuple[array, array]:
    starts, ends, failure, lengths = _escapes(r, count, path, what=what)
    _settle(r, lengths, failure, path, _span(starts, ends))
    return starts, ends


def _slices(buf: bytes, starts: array, ends: array) -> Iterator[bytes]:
    return map(buf.__getitem__, map(slice, starts, ends))


def _texts(buf: bytes, starts: array, ends: array) -> Iterator[str]:
    return map(bytes.decode, _slices(buf, starts, ends))


def _bools(bits: int, count: int) -> Iterator[bool]:
    return map(_BOOLS.__getitem__, _selector(bits, count))


def _plain(buf: bytes, starts: array, ends: array) -> _Values:
    return _Values(
        lambda: _texts(buf, starts, ends),
        codes=lambda lookup: array("H", map(lookup.get, _texts(buf, starts, ends), repeat(0))),
    )


def _read_escapes(r: Reader, count: int, path: str) -> tuple[int, int]:
    escaped = read_uleb(r)
    if escaped > count:
        _dfail(
            "range",
            path,
            f"escape count {escaped} exceeds participating row count {count}",
        )
    if escaped == 0:
        return 0, 0
    if escaped == count:
        return (1 << count) - 1, count
    escapes = read_bits(r, count, path)
    popcount = escapes.bit_count()
    if popcount != escaped:
        _dfail(
            "bitmap",
            path,
            f"escape bitmap popcount {popcount} does not equal {escaped}",
        )
    return escapes, escaped


def _nth_set(rows: bytes) -> Callable[[int], int]:
    return lambda j: next(islice(compress(itertools.count(), rows), j, None))


def _decode_string_column(
    r: Reader,
    count: int,
    path: str,
    ctx: _Ctx,
    ordinal: int,
    source_codes: Callable[..., Any] | None,
) -> _Values:
    mode = r.u8()
    if mode > 4:
        _dfail("marker", path, f"invalid string column flags 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return _NONE
    if mode == 0x00:
        return _plain(r.buf, *_literals(r, count, path))
    if mode == 0x01:
        return _dictionary_column(r, count, path, ctx, ordinal)
    if mode == 0x03:
        return _grammar_column(r, count, path, ctx, ordinal)
    if mode == 0x04:
        return _derived_column(r, count, path, ctx, ordinal, source_codes)
    return _packed_column(r, count, path, ctx)


def _dictionary_column(r: Reader, count: int, path: str, ctx: _Ctx, ordinal: int) -> _Values:
    buf = r.buf
    failure: _Failure | None = None
    make: Callable[[], Iterable[int]]
    entries = ctx.dicts.get(ordinal)
    if entries is None:
        _dfail("unsupported", path, "dictionary column requires a profile for this leaf")
    width = r.u8()
    if width > 14:
        _dfail("marker", path, f"dictionary width {width} exceeds 14")
    packed = _unpack_bits(r, count, width, path)
    if packed is None:
        return _plain(buf, *_literals(r, count, path))
    codes: array = packed
    if max(codes) > len(entries):
        index = next(compress(itertools.count(), map(len(entries).__lt__, codes)))
        failure = (index, False, DecodeError("range", f"{path}[{index}]: dictionary code {codes[index]} out of range"))
    long_codes = ctx.long_codes[ordinal]
    if long_codes:
        too_long = next(compress(itertools.count(), map(long_codes.__contains__, codes)), None)
        if too_long is not None and (failure is None or too_long < failure[0]):
            failure = (too_long, False, _too_long(path, too_long))
    escaped = codes.count(0) if failure is None else codes[: failure[0]].count(0)
    starts, ends, escape_failure, escape_lengths = _escapes(
        r, escaped, path, lambda j: next(islice(_zeros(codes), j, None))
    )
    sizes = ctx.entry_bytes[ordinal]
    if escaped:
        make = lambda: map(add, map(sizes.__getitem__, codes), _merge(map(not_, codes), repeat(0), escape_lengths()))
    else:
        make = lambda: map(sizes.__getitem__, codes)
    _settle(
        r,
        make,
        escape_failure or failure,
        path,
        (count - escaped) * ctx.longest_entry[ordinal] + _span(starts, ends),
        lambda: (
            (count - escaped) * sizes[1] if ordinal in ctx.uniform_entries else sum(map(sizes.__getitem__, codes))
        )
        + sum(escape_lengths()),
    )
    table = ctx.tables[ordinal]

    def lookup_values() -> list[Any]:
        values = list(map(table.__getitem__, codes))
        for i, text in zip(_zeros(codes), _texts(buf, starts, ends)):
            values[i] = text
        return values

    def dict_codes(lookup: dict[str, int]) -> array:
        if not escaped:
            return codes
        out = array("H", codes)
        for i, text in zip(_zeros(codes), _texts(buf, starts, ends)):
            out[i] = lookup.get(text, 0)
        return out

    return _Values(lookup_values, codes=dict_codes)


def _grammar_column(r: Reader, count: int, path: str, ctx: _Ctx, ordinal: int) -> _Values:
    buf = r.buf
    failure: _Failure | None = None
    make: Callable[[], Iterable[int]]
    grammar = ctx.grammars.get(ordinal)
    if grammar is None:
        _dfail("unsupported", path, "grammar column requires a profile for this leaf")
    escapes, escaped = _read_escapes(r, count, path)
    matched = count - escaped
    bounds = ctx.lane_bounds[ordinal]
    lanes = [
        _decode_int_column(r, node, matched, f"{path}.lane[{lane_index}]", lane=True)
        for lane_index, node in enumerate(bounds)
    ]
    rows = _selector(escapes, count) if 0 < escaped < count else b""
    at = _nth_set(rows) if rows else None
    outside: tuple[int, int] | None = None
    for lane_index, lane in enumerate(lanes):
        beyond = lane.outside
        if beyond is not None and (outside is None or beyond < outside[0]):
            outside = (beyond, lane_index)
    # every rendering of one grammar has the same length, known from its tokens
    length = ctx.grammar_bytes[ordinal]
    too_long = matched > 0 and length > r.limits.max_byte_length
    before = escaped
    if outside is not None or too_long:
        index = outside[0] if outside is not None and not too_long else 0
        row = next(islice(compress(itertools.count(), map(not_, rows)), index, None)) if rows else index
        if outside is not None and outside[0] == index:
            lane_index = outside[1]
            value = next(islice(lanes[lane_index].make(), index, None))
            failure = (row, False, _range_error(bounds[lane_index], f"{path}.lane[{lane_index}]", index, value))
        else:
            failure = (row, False, _too_long(path, row))
        before = (escapes & ((1 << row) - 1)).bit_count()
    starts, ends, escape_failure, escape_lengths = _escapes(r, before, path, at)
    if not escaped:
        _settle_uniform(r, length, count, failure, path)
    else:
        make = escape_lengths if escaped == count else lambda: _merge(rows, repeat(length), escape_lengths())
        _settle(
            r,
            make,
            escape_failure or failure,
            path,
            length * matched + _span(starts, ends),
            lambda: length * matched + sum(escape_lengths()),
        )
    render = ctx.renderers[ordinal]

    def keys() -> Iterator[Any]:
        lane_values = [lane.make() for lane in lanes]
        return iter(lane_values[0]) if len(lane_values) == 1 else zip(*lane_values)

    if not escaped and all(lane.const is not _ABSENT for lane in lanes):
        return _constant(render(next(keys())), count)

    def rendered() -> Iterator[str]:
        if not escaped:
            return map(render, keys())
        if escaped == count:
            return _texts(buf, starts, ends)
        return _merge(rows, map(render, keys()), _texts(buf, starts, ends))

    def grammar_codes(lookup: dict[str, int]) -> array:
        literal = map(lookup.get, _texts(buf, starts, ends), repeat(0))
        if escaped == count:
            return array("H", literal)
        derived = _lane_codes(lanes, matched, ctx.grammar_codes(ordinal, lookup))
        if not escaped:
            return derived if type(derived) is array else array("H", derived)
        return array("H", _merge(rows, derived, literal))

    return _Values(rendered, codes=grammar_codes)


def _derived_column(
    r: Reader, count: int, path: str, ctx: _Ctx, ordinal: int, source_codes: Callable[..., Any] | None
) -> _Values:
    buf = r.buf
    failure: _Failure | None = None
    make: Callable[[], Iterable[int]]
    derivation = ctx.derivations.get(ordinal)
    if derivation is None:
        _dfail("unsupported", path, "derived column requires a profile for this leaf")
    escapes, escaped = _read_escapes(r, count, path)
    rows = _selector(escapes, count) if 0 < escaped < count else b""
    at = _nth_set(rows) if rows else None
    assert source_codes is not None
    source: Any = source_codes(derivation["source"]) if escaped < count else 0
    if escaped < count:
        found = _first_derived_failure(source, escapes, escaped, ctx.long_derived[ordinal])
        if found is not None:
            failure = (found[0], False, DecodeError(found[1], f"{path}[{found[0]}]: {found[2]}"))
    before = escaped if failure is None else (escapes & ((1 << failure[0]) - 1)).bit_count()
    starts, ends, escape_failure, escape_lengths = _escapes(r, before, path, at)
    sizes = ctx.derived_bytes[ordinal]

    def conforming() -> Iterable[int]:
        if isinstance(source, int):
            return repeat(source)
        return compress(source, map(not_, rows)) if escaped else source

    def derived_lengths() -> Iterable[int]:
        if isinstance(source, int):
            return map(sizes.__getitem__, repeat(source, count - escaped))
        return map(sizes.__getitem__, conforming())

    if escaped == count:
        make = escape_lengths
    elif escaped:
        make = lambda: _merge(rows, derived_lengths(), escape_lengths())
    else:
        make = derived_lengths
    def derived_total() -> int:
        if isinstance(source, int) or ordinal in ctx.uniform_derived:
            conformed = sizes[source if isinstance(source, int) else 1] * (count - escaped)
        elif not escaped and 4 * count >= len(sizes):
            assert source_codes is not None
            tally = source_codes(derivation["source"], counts=True)
            conformed = sum(sizes[code] * times for code, times in tally.items() if times)
        else:
            conformed = sum(derived_lengths())
        return conformed + sum(escape_lengths())

    bound = (count - escaped) * ctx.longest_derived[ordinal] + _span(starts, ends)
    _settle(r, make, escape_failure or failure, path, bound, derived_total)
    table = ctx.derived_tables[ordinal]

    if isinstance(source, int) and not escaped:
        return _constant(table[source], count)

    def derived_values() -> Iterator[Any]:
        if escaped == count:
            return _texts(buf, starts, ends)
        values = map(table.__getitem__, conforming())
        return _merge(rows, values, _texts(buf, starts, ends)) if escaped else values

    def derived_codes(lookup: dict[str, int]) -> array:
        if escaped == count:
            return array("H", map(lookup.get, _texts(buf, starts, ends), repeat(0)))
        by_code = ctx.recodings.get(ordinal)
        if by_code is None and 4 * (count - escaped) >= len(table):
            by_code = ctx.recodings[ordinal] = {
                code: lookup.get(value, 0) for code, value in enumerate(derivation["values"], 1)
            }
        if by_code is None:
            recoded: Iterable[int] = map(_derived_code, repeat(table), repeat(lookup), conforming())
        elif escaped:
            recoded = map(by_code.get, conforming(), repeat(0))
        else:
            recoded = _recode(source, by_code)
        if escaped:
            return array("H", _merge(rows, recoded, map(lookup.get, _texts(buf, starts, ends), repeat(0))))
        return recoded if type(recoded) is array else array("H", recoded)

    return _Values(derived_values, codes=derived_codes)


def _packed_column(r: Reader, count: int, path: str, ctx: _Ctx) -> _Values:
    lengths, err = read_ulebs(r, count)
    limit = r.limits.max_byte_length
    if lengths:
        too_long = next(compress(itertools.count(), map(limit.__lt__, lengths)), None)
        over = next(compress(itertools.count(), map(limit.__lt__, accumulate(lengths))), None)
        if too_long is not None and (over is None or too_long <= over):
            _dfail("limit", f"{path}[{too_long}]", "string length exceeds limit")
        if over is not None:
            _dfail("limit", path, "packed column total exceeds limit")
    if err is not None:
        raise err
    total = sum(lengths)
    r.budget.charge_bytes(total, path, DecodeError)
    if ctx.inflate is None:
        _dfail("unsupported", path, "packed string column requires an inflate hook")
    blob_len = read_uleb(r)
    if blob_len > limit:
        _dfail("limit", path, "packed blob exceeds limit")
    blob = r.take(blob_len)
    try:
        inflated = ctx.inflate(blob, total)
    except Exception:
        _dfail("packed", path, "packed blob failed to inflate")
    if len(inflated) != total:
        _dfail("packed", path, f"packed blob inflates to {len(inflated)} bytes, expected {total}")
    inflated = bytes(inflated)
    ends = array(_UINT[4], accumulate(lengths))
    starts = array(_UINT[4], ends)
    starts.insert(0, 0)
    starts.pop()
    if not _joined_utf8(inflated, starts, total):
        for i, data in enumerate(map(inflated.__getitem__, map(slice, starts, ends))):
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                _dfail("utf8", f"{path}[{i}]", "invalid UTF-8")
    return _plain(inflated, starts, ends)


def _joined_utf8(data: bytes, starts: array, total: int) -> bool:
    """Contiguous slices are each strict UTF-8 iff the whole is and no slice
    starts inside a sequence."""
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    heads = bytes(map(data.__getitem__, filter(total.__gt__, islice(starts, 1, None))))
    return 1 not in heads.translate(_CONTINUATION)


def _lane_codes(lanes: list[_Values], rows: int, keys: dict[Any, int]) -> Iterable[int]:
    """The dictionary codes of a grammar column's `rows` matched rows, from their lanes:
    by the varying lane's value when one lane varies (the entries that match the
    constant lanes sorted out first, when there are rows enough to pay for it), else by
    the tuple of lane values."""
    fixed = [lane.const for lane in lanes]
    varying = [i for i, value in enumerate(fixed) if value is _ABSENT]
    if not varying:
        return repeat(keys.get(fixed[0] if len(fixed) == 1 else tuple(fixed), 0))
    if len(lanes) == 1:
        return _recode(lanes[0].make(), keys)
    i = varying[0]
    if len(varying) > 1 or 4 * rows < len(keys):
        return map(keys.get, zip(*(lane.make() for lane in lanes)), repeat(0))
    by_value = {
        key[i]: code for key, code in keys.items() if all(part == fixed[j] for j, part in enumerate(key) if j != i)
    }
    return _recode(lanes[i].make(), by_value)


def _recode(values: Iterable[int], table: dict[int, int]) -> Iterable[int]:
    """table.get(value, 0) for every value. Long runs of byte values translate in bulk
    through 256 of the entries; so do two-byte values that share their high byte, or
    whose table reaches only a few high bytes, one masked pass per high byte."""
    if type(values) is array and len(values) >= 256:
        if values.typecode == "B":
            return _translate(values.tobytes(), table, 0)
        if values.typecode == "H":
            data = values.tobytes()
            low, high = (data[1::2], data[0::2]) if _BIG_ENDIAN else (data[0::2], data[1::2])
            top = high[0]
            if high.count(top) == len(high):
                return _translate(low, table, top << 8)
            if 4 * len(values) >= len(table) and max(table, default=0) < _SPLIT_TOPS << 8:
                return _translate_split(low, high, table)
    return map(table.get, values, repeat(0))


_SPLIT_TOPS = 4


def _translate_split(low: bytes, high: bytes, table: dict[int, int]) -> array:
    """table.get(high << 8 | low, 0) for every pair of bytes, every key of the table
    below _SPLIT_TOPS << 8: per high byte present, the low bytes translate through its
    256 entries and a mask keeps the rows with that high byte."""
    count = len(low)
    tops = [top for top in range(_SPLIT_TOPS) if high.count(top)]
    covered = sum(map(high.count, tops)) == count
    low_out = high_out = taken = 0
    for index, top in enumerate(tops):
        if covered and index == len(tops) - 1:
            mask = ~taken & ((1 << 8 * count) - 1)
        else:
            mask = int.from_bytes(high.translate(bytes(0xFF if byte == top else 0 for byte in range(256))), "little")
            taken |= mask
        entries = [table.get((top << 8) | byte, 0) for byte in range(256)]
        low_out |= mask & int.from_bytes(low.translate(bytes(entry & 0xFF for entry in entries)), "little")
        if max(entries) > 0xFF:
            high_out |= mask & int.from_bytes(low.translate(bytes(entry >> 8 for entry in entries)), "little")
    out = bytearray(2 * count)
    first = 1 if _BIG_ENDIAN else 0
    out[first::2] = low_out.to_bytes(count, "little")
    out[1 - first :: 2] = high_out.to_bytes(count, "little")
    return array("H", out)


def _translate(data: bytes, table: dict[int, int], base: int) -> array:
    """table.get(base + byte, 0) for every byte: a byte array when every entry fits a
    byte, else two translates, one per byte of the two-byte result."""
    entries = [table.get(base + byte, 0) for byte in range(256)]
    if max(entries) < 256:
        return array("B", data.translate(bytes(entries)))
    out = bytearray(2 * len(data))
    low = 1 if _BIG_ENDIAN else 0
    out[low::2] = data.translate(bytes(entry & 0xFF for entry in entries))
    out[1 - low :: 2] = data.translate(bytes(entry >> 8 for entry in entries))
    return array("H", out)


def _derived_code(table: tuple[Any, ...], lookup: dict[str, int], code: int) -> int:
    return lookup.get(table[code], 0) if 0 < code < len(table) else 0


def _too_long(path: str, index: int) -> DecodeError:
    return DecodeError("limit", f"{path}[{index}]: reconstructed string length exceeds limit")


def _zeros(codes: array) -> Iterator[int]:
    return compress(itertools.count(), map(not_, codes))


_ZERO_FLAGS = bytes.maketrans(bytes(range(256)), b"\1" + bytes(255))
_FULL_FLAGS = bytes.maketrans(bytes(range(256)), bytes(255) + b"\1")


def _missing_flags(codes: array) -> bytes:
    """One byte per code, 1 where it is 0 or _NOT_PARTICIPATING. A two-byte code is
    either when its low and high bytes, taken as two integers, OR to zero or AND to 0xFF."""
    if codes.itemsize == 1:
        return codes.tobytes().translate(_ZERO_FLAGS)
    if codes.itemsize != 2 or len(codes) < 64:
        return bytes(map(_MISSING_CODES.__contains__, codes))
    data = codes.tobytes()
    count = len(codes)
    low = int.from_bytes(data[0::2], "little")
    high = int.from_bytes(data[1::2], "little")
    zero = int.from_bytes((low | high).to_bytes(count, "little").translate(_ZERO_FLAGS), "little")
    full = int.from_bytes((low & high).to_bytes(count, "little").translate(_FULL_FLAGS), "little")
    return (zero | full).to_bytes(count, "little")


def _first_derived_failure(
    codes: Any, escapes: int, escaped: int, long_codes: frozenset[int]
) -> tuple[int, str, str] | None:
    """The first conforming-claimed row whose source is absent or outside its
    dictionary (range), or whose derived value is over the limit (limit)."""
    if isinstance(codes, int):
        first = ((escapes + 1) & ~escapes).bit_length() - 1
        missing = first if codes in _MISSING_CODES else None
        too_long = first if codes in long_codes else None
    elif not escaped:
        found = _missing_flags(codes).find(1)
        missing = None if found < 0 else found
        too_long = (
            next(compress(itertools.count(), map(long_codes.__contains__, codes)), None) if long_codes else None
        )
    else:
        missing = _lowest(_flag_bits(_missing_flags(codes)) & ~escapes)
        too_long = _lowest(_flag_bits(bytes(map(long_codes.__contains__, codes))) & ~escapes) if long_codes else None
    if missing is not None and (too_long is None or missing <= too_long):
        if (codes if isinstance(codes, int) else codes[missing]) == _NOT_PARTICIPATING:
            return (missing, "range", "derived source does not participate in this array row")
        return (missing, "range", "derived source value is outside its dictionary")
    if too_long is not None:
        return (too_long, "limit", "reconstructed string length exceeds limit")
    return None


def _decode_enum_column(r: Reader, node: dict[str, Any], count: int, path: str, ctx: _Ctx) -> _Values:
    members = node["members"]
    sizes = ctx.member_bytes(node)
    indices = _unpack_bits(r, count, _bit_width(len(members) - 1), path)
    if indices is None:
        _settle_uniform(r, sizes[0], count, None, path)
        return _constant(members[0], count)
    found: array = indices
    failure: _Failure | None = None
    if max(found, default=0) >= len(members):
        index = next(compress(itertools.count(), map(len(members).__le__, found)))
        failure = (index, False, DecodeError("range", f"{path}[{index}]: enum index {found[index]} out of range"))
    longest = max(sizes)
    if min(sizes) == longest:
        _settle_uniform(r, longest, count, failure, path)
    else:
        _settle(r, lambda: map(sizes.__getitem__, found), failure, path, longest * count)
    return _Values(lambda: map(members.__getitem__, found))


_Column = tuple[int | None, int | None, int | None, _Values]


def _decode_columnar(
    r: Reader,
    node: dict[str, Any],
    leaves: _Leaves,
    path: str,
    depth: int,
    ctx: _Ctx,
    ordinal_base: int = 0,
) -> list[dict[str, Any]]:
    length = node.get("length")
    if length is None:
        length = read_uleb(r)
    if length > r.limits.max_items:
        _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
    _bound_amplification(r, length, path)
    r.budget.charge(length, path, DecodeError)
    count = length

    # columns stay packed, typed or arithmetic until the whole body has decoded, so a
    # malformed later column fails before any earlier one expands per row
    columns: list[_Column] = []
    sources: dict[Any, Any] = {}
    max_depth = r.limits.max_depth
    for leaf_index, (suffix, name, nesting, optional, nullable, t) in enumerate(ctx.leaf_plans[id(leaves)]):
        field_path = path + suffix
        presence = read_bits(r, count, field_path) if optional else None
        nulls = read_bits(r, count, field_path) if nullable else None
        part = presence
        if nulls:
            if presence is not None:
                stray = nulls & ~presence
                if stray:
                    _dfail("bitmap", f"{path}[{_lowest(stray)}].{name}", "null bit set for absent field")
                part = presence ^ nulls
            else:
                part = ((1 << count) - 1) ^ nulls
        participating = count if part is None else part.bit_count()

        if count > 0 and depth + nesting > max_depth:
            _dfail("depth", path, f"nesting deeper than {max_depth}")
        if participating and depth + 1 + nesting > max_depth:
            _dfail("depth", path, f"nesting deeper than {max_depth}")

        kind = t["kind"]
        values: _Values
        if kind == "int":
            values = _decode_int_column(r, t, participating, field_path)
        elif kind == "float64":
            values = _decode_float_column(r, participating, field_path)
        elif kind == "bool":
            values = _Values(partial(_bools, read_bits(r, participating, field_path), participating))
        elif kind == "string":
            ordinal = ordinal_base + leaf_index
            values = _decode_string_column(
                r,
                participating,
                field_path,
                ctx,
                ordinal,
                partial(_source_codes, ctx, columns, ordinal_base, count, sources, part)
                if ordinal in ctx.derivations
                else None,
            )
        elif kind == "enum":
            values = _decode_enum_column(r, t, participating, field_path, ctx)
        elif kind == "literal":
            literal = t["value"]
            if type(literal) is str:
                r.budget.charge_bytes(_text_bytes(literal) * participating, field_path, DecodeError)
            values = _constant(literal, participating)
        else:
            starts, ends = _literals(r, participating, field_path, "bytes")
            values = _Values(partial(_slices, r.buf, starts, ends))
        columns.append((presence, nulls, part, values))

    if not count:
        return []
    out: list[dict[str, Any]] = []
    shape = ctx.shapes[id(leaves)]
    r.deferred.append((out, lambda: _assemble(count, shape, columns)))
    return out


def _source_codes(
    ctx: _Ctx,
    columns: list[_Column],
    ordinal_base: int,
    count: int,
    found: dict[Any, Any],
    part: int | None,
    ordinal: int,
    counts: bool = False,
) -> Any:
    """A derivation source's dictionary codes at the rows a derived column with
    participation `part` covers: 0 outside the dictionary, _NOT_PARTICIPATING where
    the source is absent; with `counts`, how often each code occurs there. Every derived
    column that reads one source with the same participation shares one result, held
    in `found`."""
    if counts:
        tally = found.get(("counts", ordinal, part))
        if tally is None:
            source = _source_codes(ctx, columns, ordinal_base, count, found, part, ordinal)
            tally = found[("counts", ordinal, part)] = _tally(source, len(ctx.codes[ordinal]))
        return tally
    known = found.get((ordinal, part))
    if known is not None:
        return known
    codes: Any = found.get(ordinal)
    _presence, _nulls, source_part, values = columns[ordinal - ordinal_base]
    if codes is None:
        assert values.codes is not None
        codes = found[ordinal] = values.codes(ctx.codes[ordinal])
    if source_part is None:
        if part is None or isinstance(codes, int):
            result = codes
        else:
            result = array("H", compress(codes, _selector(part, count)))
    else:
        source_rows = _selector(source_part, count)
        if isinstance(codes, int):
            by_row: Iterable[int] = map((_NOT_PARTICIPATING, codes).__getitem__, source_rows)
        else:
            by_row = _merge(source_rows, repeat(_NOT_PARTICIPATING), codes)
        result = array("H", by_row if part is None else compress(by_row, _selector(part, count)))
    found[(ordinal, part)] = result
    return result


def _tally(codes: array, entries: int) -> dict[int, int]:
    """How often each code occurs: by one byte count per code for byte codes of a small
    dictionary when they outnumber its codes fourfold, else in one pass."""
    if codes.typecode == "B" and entries < 256 and len(codes) >= 4 * (entries + 1):
        data = codes.tobytes()
        return {code: data.count(code) for code in range(entries + 1)}
    return Counter(codes)


_Shape = tuple[list[str], list[Any]]


def _shape(leaves: _Leaves, level: int, lo: int, hi: int) -> _Shape:
    """Key names and, per key, a leaf index or the nested struct's own shape, for the
    leaves in [lo, hi), which share their first `level` segments."""
    names: list[str] = []
    entries: list[Any] = []
    index = lo
    while index < hi:
        segs = leaves[index][0]
        names.append(segs[level])
        if len(segs) == level + 1:
            entries.append(index)
            index += 1
            continue
        end = index + 1
        while end < hi and len(leaves[end][0]) > level + 1 and leaves[end][0][level] == segs[level]:
            end += 1
        entries.append(_shape(leaves, level + 1, index, end))
        index = end
    return names, entries


def _assemble(count: int, shape: _Shape, columns: list[_Column]) -> list[dict[str, Any]]:
    """One dict per row, keys in declared order, nested structs built recursively."""
    names, entries = shape
    cells: list[Iterable[Any]] = []
    optional: list[tuple[str, int]] = []
    for name, entry in zip(names, entries):
        if type(entry) is not int:
            cells.append(_assemble(count, entry, columns))
            continue
        presence, nulls, part, values = columns[entry]
        if part is None:
            cells.append(values.make())
            continue
        cells.append(_cells(count, presence, nulls, part, values))
        if presence is not None and presence.bit_count() < count:
            optional.append((name, presence))
    rows = list(map(dict, map(zip, repeat(names), zip(*cells))))
    for name, presence in optional:
        for row in compress(rows, map(not_, _selector(presence, count))):
            del row[name]
    return rows


def _cells(count: int, presence: int | None, nulls: int | None, part: int, values: _Values) -> Iterable[Any]:
    """One value per array row: absent rows hold a placeholder removed once the
    rows are built, null rows hold None."""
    cells = _merge(_selector(part, count), repeat(None if presence is None else _ABSENT), values.make())
    if presence is None or not nulls:
        return cells
    filled = list(cells)
    for i in compress(itertools.count(), _selector(nulls, count)):
        filled[i] = None
    return filled


def _default_deflate(data: bytes) -> bytes:
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def _default_inflate(data: bytes, max_output_length: int) -> bytes:
    d = zlib.decompressobj(-15)
    # cap at declared size + 1 so an over-long stream is detected, never unbounded
    out = d.decompress(data, max_output_length + 1)
    if d.unconsumed_tail:
        raise ValueError("packed blob inflates past its declared size")
    out += d.flush()
    if not d.eof:
        raise ValueError("truncated deflate stream")
    if d.unused_data:
        raise ValueError("trailing bytes after the deflate stream")
    return out


class Codec:
    def __init__(self, ir: dict[str, Any], plan: str, limits: Limits, pack, profile=None) -> None:
        validate_ir(ir)
        if profile is not None:
            if plan != "columnar":
                raise HyperflyError("ir", "profiles apply to the columnar plan only")
            validate_profile(ir, profile)
        # isolate from later caller mutation: the fingerprint is fixed at compile time
        ir = copy.deepcopy(ir)
        normalize_integers(ir)
        self._ir = ir
        self._plan = plan
        self._profile = copy.deepcopy(profile) if profile is not None else None
        if self._profile is not None:
            self._profile["version"] = int(self._profile["version"])
            normalize_integers(self._profile["shared"])
        self._artifact = serialize_artifact(ir, plan, self._profile)
        self._fp = fingerprint_of(self._artifact)
        self._limits = limits
        if pack is False:
            deflate = inflate = None
        elif pack is None:
            deflate, inflate = _default_deflate, _default_inflate
        else:
            deflate, inflate = pack.get("deflate"), pack.get("inflate")
        self._ctx = _Ctx(ir, limits, plan == "columnar", deflate, inflate, self._profile)

    @property
    def fingerprint(self) -> str:
        return self._fp.hex()

    @property
    def artifact(self) -> str:
        return self._artifact

    @property
    def plan(self) -> str:
        return self._plan

    @property
    def profile(self) -> dict[str, Any] | None:
        """A copy: the compiled profile is fixed by the fingerprint and never mutated."""
        return copy.deepcopy(self._profile) if self._profile is not None else None

    @property
    def ir(self) -> dict[str, Any]:
        """A copy: the compiled schema is fixed by the fingerprint and never mutated."""
        return copy.deepcopy(self._ir)

    def encode_body(self, value: Any) -> bytes:
        out = bytearray()
        budget = Budget(self._limits.max_total_items, self._limits.max_total_bytes)
        _encode_node(out, self._ir, value, "$", 0, self._ctx, budget)
        cap = self._limits.item_budget(len(out))
        if budget.total > cap:
            raise EncodeError("limit", f"$: {budget.total} items exceed the item budget of {cap}")
        byte_cap = self._limits.byte_budget(len(out))
        if budget.bytes > byte_cap:
            raise EncodeError("limit", f"$: {budget.bytes} bytes exceed the byte budget of {byte_cap}")
        return bytes(out)

    def decode_body(self, data: bytes) -> Any:
        r = Reader(bytes(data), self._limits)
        value = _decode_node(r, self._ir, "$", 0, self._ctx)
        r.expect_end()
        for items, build in r.deferred:
            items.extend(build())
        return value

    def encode(self, value: Any) -> bytes:
        return MAGIC + bytes([WIRE_VERSION]) + self._fp + self.encode_body(value)

    def decode(self, data: bytes) -> Any:
        data = bytes(data)
        if len(data) < HEADER_SIZE:
            raise DecodeError("header", "shorter than envelope header")
        if data[:2] != MAGIC:
            raise DecodeError("header", "bad magic")
        if data[2] != WIRE_VERSION:
            raise DecodeError("header", f"unsupported wire major {data[2]}")
        actual = data[3:HEADER_SIZE].hex()
        if data[3:HEADER_SIZE] != self._fp:
            raise FingerprintMismatchError(self._fp.hex(), actual)
        return self.decode_body(data[HEADER_SIZE:])


_LIMIT_FIELDS = tuple(field.name for field in dataclasses.fields(Limits))


def checked_options(plan: Any, limits: Any, pack: Any) -> tuple[str, Limits, Any]:
    """Reads each compile option once and returns a checked copy; anything malformed
    raises code "options" before the IR is read."""
    try:
        return _checked_options(plan, limits, pack)
    except MemoryError:
        raise
    except Exception as error:
        if type(error) is HyperflyError and type(error.code) is str and error.code == "options":
            raise
        raise HyperflyError("options", "options: could not read compile options") from error


def _checked_options(plan: Any, limits: Any, pack: Any) -> tuple[str, Limits, Any]:
    checked_limits = DEFAULT_LIMITS
    if limits is not None:
        if not isinstance(limits, Limits):
            raise HyperflyError("options", "limits: must be a Limits instance")
        values = {}
        for name in _LIMIT_FIELDS:
            value = getattr(limits, name)
            number = int.__index__(value) if isinstance(value, int) and not isinstance(value, bool) else -1
            if not 0 <= number <= INT_MAX:
                raise HyperflyError("options", f"limits.{name}: must be a non-negative safe integer")
            values[name] = number
        checked_limits = Limits(**values)
    if not isinstance(plan, str) or str.__str__(plan) not in ("row", "columnar"):
        raise HyperflyError("options", "plan: must be row or columnar")
    checked_plan = str.__str__(plan)
    checked_pack = pack
    if pack is not None and pack is not False:
        if not isinstance(pack, Mapping):
            raise HyperflyError("options", "pack: must be False or a mapping")
        hooks = {"deflate": pack.get("deflate"), "inflate": pack.get("inflate")}
        for key, hook in hooks.items():
            if hook is not None and not callable(hook):
                raise HyperflyError("options", f"pack.{key}: must be callable")
        checked_pack = hooks
    return checked_plan, checked_limits, checked_pack


def compile_ir(
    ir: Any,
    *,
    plan: str = "row",
    limits: Limits | None = None,
    pack=None,
    profile: Any = None,
) -> Codec:
    plan, limits, pack = checked_options(plan, limits, pack)
    try:
        return Codec(ir, plan, limits, pack, profile)
    except RecursionError:
        # TS has no schema depth limit. Python's recursive validation, copying,
        # serialization and profile column walk share an interpreter limit;
        # report it as invalid IR rather than leaking an interpreter exception.
        _fail("$", "IR or profile nesting exceeds Python's recursion limit")
