from __future__ import annotations

import copy
import math
import struct
import zlib
from typing import Any

from ._ir import (
    LEAF_KINDS,
    array_ordinal_bases,
    fingerprint_of,
    has_payload,
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
    Limits,
    Reader,
    read_bitmap,
    read_uleb,
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


def _bound_by_input(r: Reader, count: int, element: dict[str, Any], path: str) -> None:
    """A declared count must be payable by the bytes still on the wire: any element that
    carries payload costs at least one bit, so truncation cannot force a huge allocation."""
    if count == 0 or not has_payload(element):
        return
    if count > r.remaining() * 8:
        _dfail("limit", path, f"declared {count} items but only {r.remaining()} byte(s) remain")


def _efail(code: str, path: str, message: str) -> None:
    raise EncodeError(code, f"{path}: {message}")


def _dfail(code: str, path: str, message: str) -> None:
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
    f = float(v)
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


def _type_accepts_null(node: dict[str, Any]) -> bool:
    return node["kind"] == "nullable" or (node["kind"] == "literal" and node["value"] is None)


def _literal_matches(lit: Any, v: Any) -> bool:
    if lit is None:
        return v is None
    if type(lit) is bool:
        return v is lit
    if type(lit) is int:
        return type(v) is int and v == lit
    return type(v) is str and v == lit


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
        "columnar",
        "deflate",
        "inflate",
        "dicts",
        "codes",
        "bases",
    )

    def __init__(self, limits: Limits, columnar: bool, deflate, inflate, profile=None, bases=None) -> None:
        self.dicts: dict[int, list[str]] = {}
        self.codes: dict[int, dict[str, int]] = {}
        self.bases = bases or {}
        if profile is not None:
            for column in profile["shared"]["columns"]:
                self.dicts[column["leaf"]] = column["dict"]
                self.codes[column["leaf"]] = {v: i + 1 for i, v in enumerate(column["dict"])}
        self.max_depth = limits.max_depth
        self.max_items = limits.max_items
        self.max_byte_length = limits.max_byte_length
        self.columnar = columnar
        self.deflate = deflate
        self.inflate = inflate


def _encode_node(out: bytearray, node: dict[str, Any], value: Any, path: str, depth: int, ctx: _Ctx) -> None:
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
        write_uleb(out, len(data))
        out += data
    elif kind == "bytes":
        if not isinstance(value, (bytes, bytearray)):
            _efail("type", path, "expected bytes")
        if len(value) > ctx.max_byte_length:
            _efail("limit", path, f"bytes of {len(value)} exceeds the codec limit")
        write_uleb(out, len(value))
        out += value
    elif kind == "literal":
        if not _literal_matches(node["value"], value):
            _efail("type", path, f"expected literal {node['value']!r}")
    elif kind == "enum":
        if type(value) is not str:
            value = getattr(value, "value", value)
        try:
            index = node["members"].index(value)
        except (ValueError, TypeError):
            _efail("type", path, f"{value!r} is not an enum member")
        write_uleb(out, index)
    elif kind == "nullable":
        if value is None:
            out.append(0)
        else:
            out.append(1)
            _encode_node(out, node["inner"], value, path, depth + 1, ctx)
    elif kind == "array":
        if ctx.columnar and _columnar_eligible(node):
            _encode_columnar(out, node, value, path, depth, ctx)
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
        for i, item in enumerate(value):
            _encode_node(out, node["element"], item, f"{path}[{i}]", depth + 1, ctx)
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
        for f in node["fields"]:
            if f["name"] not in value:
                continue
            v = value[f["name"]]
            if v is None and f.get("nullable"):
                continue
            _encode_node(out, f["type"], v, f"{path}.{f['name']}", depth + 1, ctx)
    else:
        _efail("type", path, f"unknown kind {kind}")


def _encode_int_column(out: bytearray, node: dict[str, Any], values: list[int]) -> None:
    if not values:
        out.append(0)
        return
    forms = [_int_form(node, v) for v in values]
    diffs = [zigzag(values[i] - values[i - 1]) for i in range(1, len(values))]
    raw_cost = sum(uleb_len(f) for f in forms)
    delta_cost = uleb_len(forms[0]) + sum(uleb_len(d) for d in diffs)
    if delta_cost < raw_cost:
        out.append(1)
        write_uleb(out, forms[0])
        for d in diffs:
            write_uleb(out, d)
    else:
        out.append(0)
        for f in forms:
            write_uleb(out, f)


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


def _encode_string_column(out: bytearray, values: list[Any], path: str, ctx: _Ctx, ordinal: int) -> None:
    if not values:
        out.append(0)
        return
    encoded = [_utf8(v, f"{path}[{i}]") for i, v in enumerate(values)]
    plain_cost = sum(uleb_len(len(b)) + len(b) for b in encoded)

    codes = None
    dict_cost = math.inf
    lookup = ctx.codes.get(ordinal)
    if lookup is not None:
        codes = [lookup.get(v, 0) for v in values]
        dict_cost = sum(
            uleb_len(c) + (uleb_len(len(encoded[i])) + len(encoded[i]) if c == 0 else 0)
            for i, c in enumerate(codes)
        )

    packed = None
    packed_cost = math.inf
    if ctx.deflate is not None and ctx.inflate is not None:
        packed = ctx.deflate(b"".join(encoded))
        packed_cost = sum(uleb_len(len(b)) for b in encoded) + uleb_len(len(packed)) + len(packed)

    best = min(plain_cost, dict_cost, packed_cost)
    if best == plain_cost:
        out.append(0x00)
        for b in encoded:
            write_uleb(out, len(b))
            out += b
        return
    if best == dict_cost and codes is not None:
        out.append(0x01)
        for i, c in enumerate(codes):
            write_uleb(out, c)
            if c == 0:
                write_uleb(out, len(encoded[i]))
                out += encoded[i]
        return
    out.append(0x02)
    for b in encoded:
        write_uleb(out, len(b))
    write_uleb(out, len(packed))
    out += packed


def _encode_columnar(out: bytearray, node: dict[str, Any], value: Any, path: str, depth: int, ctx: _Ctx) -> None:
    element = node["element"]
    if type(value) is not list:
        _efail("type", path, "expected array")
    length = node.get("length")
    if length is not None:
        if len(value) != length:
            _efail("type", path, f"fixed array expects {length} items, got {len(value)}")
    else:
        write_uleb(out, len(value))

    rows: list[dict[str, Any]] = []
    for i, row in enumerate(value):
        if not isinstance(row, dict):
            _efail("type", f"{path}[{i}]", "expected object")
        rows.append(row)

    leaves = _flatten_leaves(element)
    assert leaves is not None
    ordinal_base = ctx.bases.get(id(node), 0)

    def container(row: dict[str, Any], segs: tuple[str, ...], i: int) -> dict[str, Any]:
        obj = row
        for seg in segs[:-1]:
            nxt = obj.get(seg)
            if not isinstance(nxt, dict):
                code = "required" if seg not in obj else "type"
                _efail(code, f"{path}[{i}].{seg}", "expected object")
            obj = nxt
        return obj

    for leaf_index, (segs, field) in enumerate(leaves):
        dotted = ".".join(segs)
        leaf = segs[-1]
        field_path = f"{path}[].{dotted}"
        holders = [container(row, segs, i) for i, row in enumerate(rows)]
        states = []
        for i, holder in enumerate(holders):
            absent = leaf not in holder
            v = holder.get(leaf)
            if absent and not field.get("optional"):
                _efail("required", f"{path}[{i}].{dotted}", "required field missing")
            if not absent and v is None and not field.get("nullable") and not _type_accepts_null(field["type"]):
                _efail("type", f"{path}[{i}].{dotted}", "null for non-nullable field")
            states.append((not absent, not absent and v is None))
        if field.get("optional"):
            write_bitmap(out, [s[0] for s in states])
        if field.get("nullable"):
            write_bitmap(out, [s[0] and s[1] for s in states])

        participating = [
            holders[i][leaf]
            for i in range(len(rows))
            if states[i][0] and not (states[i][1] and field.get("nullable"))
        ]

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
            _encode_string_column(out, participating, field_path, ctx, ordinal_base + leaf_index)
        else:
            for i, v in enumerate(participating):
                _encode_node(out, t, v, f"{field_path}[{i}]", depth + 2, ctx)


def _decode_node(r: Reader, node: dict[str, Any], path: str, depth: int, ctx: _Ctx) -> Any:
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
        data = r.take(n)
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            _dfail("utf8", path, "invalid UTF-8")
    if kind == "bytes":
        n = read_uleb(r)
        if n > r.limits.max_byte_length:
            _dfail("limit", path, "bytes length exceeds limit")
        return bytes(r.take(n))
    if kind == "literal":
        return node["value"]
    if kind == "enum":
        index = read_uleb(r)
        if index >= len(node["members"]):
            _dfail("range", path, f"enum index {index} out of range")
        return node["members"][index]
    if kind == "nullable":
        marker = r.u8()
        if marker == 0:
            return None
        if marker != 1:
            _dfail("marker", path, f"invalid nullable marker 0x{marker:x}")
        return _decode_node(r, node["inner"], path, depth + 1, ctx)
    if kind == "array":
        if ctx.columnar and _columnar_eligible(node):
            return _decode_columnar(r, node, path, depth, ctx)
        length = node.get("length")
        if length is None:
            length = read_uleb(r)
        if length > r.limits.max_items:
            _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
        _bound_by_input(r, length, node["element"], path)
        return [_decode_node(r, node["element"], f"{path}[{i}]", depth + 1, ctx) for i in range(length)]
    if kind == "struct":
        optional = [f for f in node["fields"] if f.get("optional")]
        nullable = [f for f in node["fields"] if f.get("nullable")]
        presence = read_bitmap(r, len(optional), path)
        nulls = read_bitmap(r, len(nullable), path)
        pi = ni = 0
        out: dict[str, Any] = {}
        for f in node["fields"]:
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
            out[f["name"]] = _decode_node(r, f["type"], f"{path}.{f['name']}", depth + 1, ctx)
        return out
    _dfail("marker", path, f"unknown kind {kind}")


def _decode_int_column(r: Reader, node: dict[str, Any], count: int, path: str) -> list[int]:
    mode = r.u8()
    if mode > 1:
        _dfail("marker", path, f"invalid int column mode 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return []
    lo = node.get("min")
    if mode == 0:
        return [_decode_int_value(node, read_uleb(r), f"{path}[{i}]") for i in range(count)]
    out = []
    raw = read_uleb(r)
    prev = raw + lo if lo is not None else unzigzag(raw)
    out.append(_check_decoded(node, prev, f"{path}[0]"))
    for i in range(1, count):
        prev += unzigzag(read_uleb(r))
        out.append(_check_decoded(node, prev, f"{path}[{i}]"))
    return out


def _check_decoded(node: dict[str, Any], value: int, path: str) -> int:
    if value < INT_MIN or value > INT_MAX:
        _dfail("range", path, "decoded integer outside the v0 domain")
    lo, hi = node.get("min"), node.get("max")
    if lo is not None and value < lo:
        _dfail("range", path, "below declared min")
    if hi is not None and value > hi:
        _dfail("range", path, "above declared max")
    return value


def _decode_float_column(r: Reader, count: int, path: str) -> list[float]:
    mode = r.u8()
    if mode > 3:
        _dfail("marker", path, f"invalid float column mode 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return []

    def validate(bits: int, i: int) -> float:
        if bits == _NEG_ZERO_BITS:
            _dfail("float", f"{path}[{i}]", "negative-zero bit pattern")
        value = _bits_float(bits)
        if not math.isfinite(value):
            _dfail("float", f"{path}[{i}]", "non-finite float64")
        return value

    if mode >= 2:
        scale = r.u8()
        if scale > _MAX_SCALE:
            _dfail("marker", path, f"decimal scale {scale} exceeds {_MAX_SCALE}")
        pow10 = _POW10[scale]

        def mantissa(m: int, i: int) -> float:
            if m < INT_MIN or m > INT_MAX:
                _dfail("range", f"{path}[{i}]", "decimal mantissa outside the v0 domain")
            return m / pow10

        if mode == 3:
            return [mantissa(unzigzag(read_uleb(r)), i) for i in range(count)]
        prev = unzigzag(read_uleb(r))
        out = [mantissa(prev, 0)]
        for i in range(1, count):
            prev += unzigzag(read_uleb(r))
            out.append(mantissa(prev, i))
        return out

    if mode == 0:
        return [validate(struct.unpack("<Q", r.take(8))[0], i) for i in range(count)]
    prev_bits = struct.unpack("<Q", r.take(8))[0]
    out = [validate(prev_bits, 0)]
    for i in range(1, count):
        n = r.u8()
        if n > 8:
            _dfail("marker", f"{path}[{i}]", f"xor length {n} exceeds 8")
        x = int.from_bytes(r.take(n), "little") if n else 0
        if n > 0 and x >> (8 * (n - 1)) == 0:
            _dfail("float", f"{path}[{i}]", "non-minimal xor encoding")
        prev_bits ^= x
        out.append(validate(prev_bits, i))
    return out


def _decode_string_column(r: Reader, count: int, path: str, ctx: _Ctx, ordinal: int = 0) -> list[str]:
    mode = r.u8()
    if mode > 2:
        _dfail("marker", path, f"invalid string column flags 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return []

    def decode_slice(data: bytes, i: int) -> str:
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            _dfail("utf8", f"{path}[{i}]", "invalid UTF-8")
        raise AssertionError

    if mode == 0:
        out = []
        for i in range(count):
            n = read_uleb(r)
            if n > r.limits.max_byte_length:
                _dfail("limit", f"{path}[{i}]", "string length exceeds limit")
            out.append(decode_slice(r.take(n), i))
        return out

    if mode == 0x01:
        entries = ctx.dicts.get(ordinal)
        if entries is None:
            _dfail("unsupported", path, "dictionary column requires a profile for this leaf")
        out = []
        for i in range(count):
            code = read_uleb(r)
            if code == 0:
                n = read_uleb(r)
                if n > r.limits.max_byte_length:
                    _dfail("limit", f"{path}[{i}]", "string length exceeds limit")
                out.append(decode_slice(r.take(n), i))
            else:
                if code > len(entries):
                    _dfail("range", f"{path}[{i}]", f"dictionary code {code} out of range")
                out.append(entries[code - 1])
        return out

    lengths = []
    total = 0
    for i in range(count):
        n = read_uleb(r)
        if n > r.limits.max_byte_length:
            _dfail("limit", f"{path}[{i}]", "string length exceeds limit")
        lengths.append(n)
        total += n
        if total > r.limits.max_byte_length:
            _dfail("limit", path, "packed column total exceeds limit")
    blob_len = read_uleb(r)
    if blob_len > r.limits.max_byte_length:
        _dfail("limit", path, "packed blob exceeds limit")
    blob = r.take(blob_len)
    if ctx.inflate is None:
        _dfail("unsupported", path, "packed string column requires an inflate hook")
    try:
        inflated = ctx.inflate(blob, total)
    except Exception:
        _dfail("packed", path, "packed blob failed to inflate")
    if len(inflated) != total:
        _dfail("packed", path, f"packed blob inflates to {len(inflated)} bytes, expected {total}")
    out = []
    offset = 0
    for i, n in enumerate(lengths):
        out.append(decode_slice(inflated[offset : offset + n], i))
        offset += n
    return out


def _decode_columnar(r: Reader, node: dict[str, Any], path: str, depth: int, ctx: _Ctx) -> list[dict[str, Any]]:
    element = node["element"]
    length = node.get("length")
    if length is None:
        length = read_uleb(r)
    if length > r.limits.max_items:
        _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
    _bound_by_input(r, length, element, path)
    count = length

    rows: list[dict[str, Any]] = [{} for _ in range(count)]
    leaves = _flatten_leaves(element)
    assert leaves is not None
    ordinal_base = ctx.bases.get(id(node), 0)
    def container(row: dict[str, Any], segs: tuple[str, ...]) -> dict[str, Any]:
        obj = row
        for seg in segs[:-1]:
            obj = obj.setdefault(seg, {})
        return obj

    for leaf_index, (segs, field) in enumerate(leaves):
        leaf = segs[-1]
        field_path = f"{path}[].{'.'.join(segs)}"
        # nested structs are required and non-nullable: materialize the container chain at
        # this leaf's declared position for every row (order-preserving, empty-safe)
        if len(segs) > 1:
            for row in rows:
                container(row, segs)
        presence = read_bitmap(r, count, field_path) if field.get("optional") else None
        nulls = read_bitmap(r, count, field_path) if field.get("nullable") else None

        slots = []
        for i in range(count):
            present = presence[i] if presence is not None else True
            is_null = nulls[i] if nulls is not None else False
            if not present:
                if is_null:
                    _dfail("bitmap", f"{path}[{i}].{leaf}", "null bit set for absent field")
                continue
            if is_null:
                container(rows[i], segs)[leaf] = None
                continue
            slots.append(i)

        if count > 0 and depth + len(segs) > r.limits.max_depth:
            _dfail("depth", path, f"nesting deeper than {r.limits.max_depth}")
        if slots and depth + 1 + len(segs) > r.limits.max_depth:
            _dfail("depth", path, f"nesting deeper than {r.limits.max_depth}")

        t = field["type"]
        kind = t["kind"]
        if kind == "int":
            values = _decode_int_column(r, t, len(slots), field_path)
        elif kind == "float64":
            values = _decode_float_column(r, len(slots), field_path)
        elif kind == "bool":
            values = read_bitmap(r, len(slots), field_path)
        elif kind == "string":
            values = _decode_string_column(r, len(slots), field_path, ctx, ordinal_base + leaf_index)
        else:
            values = [
                _decode_node(r, t, f"{path}[{row}].{leaf}", depth + 2, ctx) for row in slots
            ]
        for j, row_index in enumerate(slots):
            container(rows[row_index], segs)[leaf] = values[j]

    return rows


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
        self._ir = ir
        self.plan = plan
        self.profile = copy.deepcopy(profile) if profile is not None else None
        self.artifact = serialize_artifact(ir, plan, self.profile)
        self._fp = fingerprint_of(self.artifact)
        self.fingerprint = self._fp.hex()
        self._limits = limits
        if pack is False:
            deflate = inflate = None
        elif pack is None:
            deflate, inflate = _default_deflate, _default_inflate
        else:
            deflate, inflate = pack.get("deflate"), pack.get("inflate")
        self._ctx = _Ctx(limits, plan == "columnar", deflate, inflate, self.profile, array_ordinal_bases(ir))

    @property
    def ir(self) -> dict[str, Any]:
        """A copy: the compiled schema is fixed by the fingerprint and never mutated."""
        return copy.deepcopy(self._ir)

    def encode_body(self, value: Any) -> bytes:
        out = bytearray()
        _encode_node(out, self._ir, value, "$", 0, self._ctx)
        return bytes(out)

    def decode_body(self, data: bytes) -> Any:
        r = Reader(bytes(data), self._limits)
        value = _decode_node(r, self._ir, "$", 0, self._ctx)
        r.expect_end()
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
        if actual != self.fingerprint:
            raise FingerprintMismatchError(self.fingerprint, actual)
        return self.decode_body(data[HEADER_SIZE:])


def compile_ir(
    ir: dict[str, Any],
    *,
    plan: str = "row",
    limits: Limits | None = None,
    pack=None,
    profile: dict[str, Any] | None = None,
) -> Codec:
    return Codec(ir, plan, limits or DEFAULT_LIMITS, pack, profile)
