from __future__ import annotations

import copy
import math
import struct
import zlib
from bisect import bisect_left
from typing import Any

from ._ir import (
    LEAF_KINDS,
    column_count,
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


def _bound_amplification(r: Reader, count: int, path: str) -> None:
    limit = r.limits.max_amplification
    if count > (r.remaining() + 1) * limit:
        _dfail(
            "limit",
            path,
            f"{count} rows from {r.remaining()} remaining byte(s) exceeds the amplification limit",
        )


def _bound_by_input(r: Reader, count: int, element: dict[str, Any], path: str) -> None:
    """Apply the row plan's one-bit floor, falling back to amplification for
    genuinely zero-payload elements."""
    if count == 0:
        return
    if not has_payload(element):
        _bound_amplification(r, count, path)
        return
    if count > r.remaining() * 8:
        _dfail("limit", path, f"declared {count} items but only {r.remaining()} byte(s) remain")


def _check_amplification(count: int, payload_bytes: int, ctx: _Ctx, path: str) -> None:
    if count > (payload_bytes + 1) * ctx.max_amplification:
        _efail(
            "limit",
            path,
            f"{count} rows in {payload_bytes} payload byte(s) exceeds the amplification limit",
        )


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


def _unpack_bits(r: Reader, count: int, width: int, path: str) -> list[int]:
    if width > _MAX_WIDTH:
        _dfail("marker", path, f"bit width {width} exceeds {_MAX_WIDTH}")
    if width == 0:
        return [0] * count
    data = r.take(_packed_bytes(count, width))
    mask = (1 << width) - 1
    out: list[int] = []
    acc = 0
    bits = 0
    index = 0
    for _ in range(count):
        while bits < width:
            acc |= (data[index] if index < len(data) else 0) << bits
            index += 1
            bits += 8
        out.append(acc & mask)
        acc >>= width
        bits -= width
    # leftover bits are padding and must be zero, or one value would have two encodings
    if acc:
        _dfail("bitmap", path, "nonzero bit-packing padding")
    return out


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
        "max_amplification",
        "columnar",
        "deflate",
        "inflate",
        "dicts",
        "codes",
        "grammars",
        "derivations",
    )

    def __init__(self, limits: Limits, columnar: bool, deflate, inflate, profile=None) -> None:
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


def _encode_node(out: bytearray, node: dict[str, Any], value: Any, path: str, depth: int, ctx: _Ctx, column: int = 0) -> None:
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
            _encode_node(out, node["inner"], value, path, depth + 1, ctx, column)
    elif kind == "array":
        if ctx.columnar and _columnar_eligible(node):
            _encode_columnar(out, node, value, path, depth, ctx, column)
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
        payload_start = len(out)
        for i, item in enumerate(value):
            _encode_node(out, node["element"], item, f"{path}[{i}]", depth + 1, ctx, column)
        _check_amplification(len(value), len(out) - payload_start, ctx, path)
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
            field_column += column_count(f["type"])
            if f["name"] not in value:
                continue
            v = value[f["name"]]
            if v is None and f.get("nullable"):
                continue
            _encode_node(out, f["type"], v, f"{path}.{f['name']}", depth + 1, ctx, base)
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
    out: bytearray, node: dict[str, Any], values: list[Any], path: str
) -> None:
    indices = []
    for i, value in enumerate(values):
        if type(value) is not str:
            value = getattr(value, "value", value)
        try:
            indices.append(node["members"].index(value))
        except (ValueError, TypeError):
            _efail("type", f"{path}[{i}]", f"{value!r} is not an enum member")
    _pack_bits(out, indices, _bit_width(len(node["members"]) - 1))


def _encode_columnar(
    out: bytearray,
    node: dict[str, Any],
    value: Any,
    path: str,
    depth: int,
    ctx: _Ctx,
    ordinal_base: int = 0,
) -> None:
    element = node["element"]
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
    payload_start = len(out)

    rows: list[dict[str, Any]] = []
    for i, row in enumerate(value):
        if not isinstance(row, dict):
            _efail("type", f"{path}[{i}]", "expected object")
        rows.append(row)

    leaves = _flatten_leaves(element)
    assert leaves is not None

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
                ordinal_base + leaf_index,
            )
        elif kind == "enum":
            _encode_enum_column(out, t, participating, field_path)
        else:
            for i, v in enumerate(participating):
                _encode_node(out, t, v, f"{field_path}[{i}]", depth + 2, ctx)

    _check_amplification(len(rows), len(out) - payload_start, ctx, path)


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
        return _decode_node(r, node["inner"], path, depth + 1, ctx, column)
    if kind == "array":
        if ctx.columnar and _columnar_eligible(node):
            return _decode_columnar(r, node, path, depth, ctx, column)
        length = node.get("length")
        if length is None:
            length = read_uleb(r)
        if length > r.limits.max_items:
            _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
        _bound_by_input(r, length, node["element"], path)
        return [_decode_node(r, node["element"], f"{path}[{i}]", depth + 1, ctx, column) for i in range(length)]
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
            field_column += column_count(f["type"])
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


def _decode_int_column(r: Reader, node: dict[str, Any], count: int, path: str) -> list[int]:
    mode = r.u8()
    if mode > 4:
        _dfail("marker", path, f"invalid int column mode 0x{mode:x}")
    if count == 0:
        if mode != 0:
            _dfail("marker", path, "empty column must use mode 0x00")
        return []
    lo = node.get("min")
    if mode == 0x00:
        return [_decode_int_value(node, read_uleb(r), f"{path}[{i}]") for i in range(count)]
    if mode == 0x02:
        base = unzigzag(read_uleb(r))
        width = r.u8()
        packed = _unpack_bits(r, count, width, path)
        return [_check_decoded(node, base + packed[i], f"{path}[{i}]") for i in range(count)]
    if mode == 0x03:
        if count < 2:
            _dfail("marker", path, "delta frame requires at least two values")
        raw_first = read_uleb(r)
        running = raw_first + lo if lo is not None else unzigzag(raw_first)
        base = unzigzag(read_uleb(r))
        width = r.u8()
        packed = _unpack_bits(r, max(0, count - 1), width, path)
        acc = [_check_decoded(node, running, f"{path}[0]")]
        for i in range(1, count):
            running += base + packed[i - 1]
            acc.append(_check_decoded(node, running, f"{path}[{i}]"))
        return acc
    if mode == 0x04:
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
        exceptions = read_bitmap(r, count, path)
        lows = _unpack_bits(r, count, low_width, path)
        highs = _unpack_bits(r, sum(exceptions), high_width, path)
        high_index = 0
        values = []
        for i in range(count):
            high = 0
            if exceptions[i]:
                high = highs[high_index]
                high_index += 1
                if high == 0:
                    _dfail(
                        "bitmap",
                        f"{path}[{i}]",
                        "patched frame exception has a zero high part",
                    )
            value = base + lows[i] + (high << low_width)
            values.append(_check_decoded(node, value, f"{path}[{i}]"))
        return values
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


def _decode_string_column(
    r: Reader,
    slots: list[int],
    source_value,
    path: str,
    ctx: _Ctx,
    ordinal: int = 0,
) -> list[str]:
    count = len(slots)
    mode = r.u8()
    if mode > 4:
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

    def read_literal(i: int) -> str:
        length = read_uleb(r)
        if length > r.limits.max_byte_length:
            _dfail("limit", f"{path}[{i}]", "string length exceeds limit")
        return decode_slice(r.take(length), i)

    def check_profile_length(value: str, i: int) -> str:
        if len(value.encode("utf-8")) > r.limits.max_byte_length:
            _dfail("limit", f"{path}[{i}]", "reconstructed string length exceeds limit")
        return value

    def read_escapes() -> tuple[list[bool], int]:
        escape_count = read_uleb(r)
        if escape_count > count:
            _dfail(
                "range",
                path,
                f"escape count {escape_count} exceeds participating row count {count}",
            )
        if escape_count == 0:
            return [False] * count, 0
        if escape_count == count:
            return [True] * count, count
        escaped = read_bitmap(r, count, path)
        popcount = sum(escaped)
        if popcount != escape_count:
            _dfail(
                "bitmap",
                path,
                f"escape bitmap popcount {popcount} does not equal {escape_count}",
            )
        return escaped, escape_count

    if mode == 0:
        return [read_literal(i) for i in range(count)]

    if mode == 0x01:
        entries = ctx.dicts.get(ordinal)
        if entries is None:
            _dfail("unsupported", path, "dictionary column requires a profile for this leaf")
        width = r.u8()
        if width > 14:
            _dfail("marker", path, f"dictionary width {width} exceeds 14")
        codes = _unpack_bits(r, count, width, path)
        out: list[str] = []
        for i, code in enumerate(codes):
            if code == 0:
                out.append(read_literal(i))
            else:
                if code > len(entries):
                    _dfail("range", f"{path}[{i}]", f"dictionary code {code} out of range")
                out.append(check_profile_length(entries[code - 1], i))
        return out

    if mode == 0x03:
        grammar = ctx.grammars.get(ordinal)
        if grammar is None:
            _dfail("unsupported", path, "grammar column requires a profile for this leaf")
        escaped, escape_count = read_escapes()
        matched_count = count - escape_count
        numeric = [token for token in grammar if "num" in token]
        lanes = [
            _decode_int_column(
                r,
                {"min": 0, "max": _grammar_limit(token) - 1},
                matched_count,
                f"{path}.lane[{lane_index}]",
            )
            for lane_index, token in enumerate(numeric)
        ]
        out = []
        matched = 0
        for i in range(count):
            if escaped[i]:
                out.append(read_literal(i))
                continue
            lane_values = [lane[matched] for lane in lanes]
            out.append(check_profile_length(_render_grammar(grammar, lane_values), i))
            matched += 1
        return out

    if mode == 0x04:
        derivation = ctx.derivations.get(ordinal)
        if derivation is None:
            _dfail("unsupported", path, "derived column requires a profile for this leaf")
        escaped, _escape_count = read_escapes()
        source_lookup = ctx.codes[derivation["source"]]
        out = []
        for i in range(count):
            if escaped[i]:
                out.append(read_literal(i))
                continue
            source = source_value(derivation["source"], slots[i])
            if type(source) is not str:
                _dfail(
                    "range",
                    f"{path}[{i}]",
                    "derived source does not participate in this array row",
                )
            code = source_lookup.get(source)
            if code is None:
                _dfail(
                    "range",
                    f"{path}[{i}]",
                    "derived source value is outside its dictionary",
                )
            out.append(check_profile_length(derivation["values"][code - 1], i))
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


def _decode_enum_column(
    r: Reader, node: dict[str, Any], count: int, path: str
) -> list[str]:
    width = _bit_width(len(node["members"]) - 1)
    indices = _unpack_bits(r, count, width, path)
    out = []
    for i, index in enumerate(indices):
        if index >= len(node["members"]):
            _dfail("range", f"{path}[{i}]", f"enum index {index} out of range")
        out.append(node["members"][index])
    return out


def _decode_columnar(
    r: Reader,
    node: dict[str, Any],
    path: str,
    depth: int,
    ctx: _Ctx,
    ordinal_base: int = 0,
) -> list[dict[str, Any]]:
    element = node["element"]
    length = node.get("length")
    if length is None:
        length = read_uleb(r)
    if length > r.limits.max_items:
        _dfail("limit", path, f"array count {length} exceeds limit {r.limits.max_items}")
    _bound_amplification(r, length, path)
    count = length

    leaves = _flatten_leaves(element)
    assert leaves is not None

    decoded = []

    def source_value(ordinal: int, row: int) -> Any:
        local = ordinal - ordinal_base
        if local < 0 or local >= len(decoded):
            return None
        entry = decoded[local]
        slots = entry["slots"]
        index = bisect_left(slots, row)
        if index >= len(slots) or slots[index] != row:
            return None
        return entry["values"][index]

    for leaf_index, (segs, field) in enumerate(leaves):
        leaf = segs[-1]
        field_path = f"{path}[].{'.'.join(segs)}"
        presence = read_bitmap(r, count, field_path) if field.get("optional") else None
        nulls = read_bitmap(r, count, field_path) if field.get("nullable") else None

        slots = []
        null_rows = []
        for i in range(count):
            present = presence[i] if presence is not None else True
            is_null = nulls[i] if nulls is not None else False
            if not present:
                if is_null:
                    _dfail("bitmap", f"{path}[{i}].{leaf}", "null bit set for absent field")
                continue
            if is_null:
                null_rows.append(i)
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
            values = _decode_string_column(
                r,
                slots,
                source_value,
                field_path,
                ctx,
                ordinal_base + leaf_index,
            )
        elif kind == "enum":
            values = _decode_enum_column(r, t, len(slots), field_path)
        else:
            values = [
                _decode_node(
                    r,
                    t,
                    f"{path}[{row}].{leaf}",
                    depth + 2,
                    ctx,
                    ordinal_base + leaf_index,
                )
                for row in slots
            ]
        decoded.append({"slots": slots, "values": values, "null_rows": null_rows})

    rows: list[dict[str, Any]] = [{} for _ in range(count)]

    def container(row: dict[str, Any], segs: tuple[str, ...]) -> dict[str, Any]:
        obj = row
        for seg in segs[:-1]:
            obj = obj.setdefault(seg, {})
        return obj

    for leaf_index, (segs, _field) in enumerate(leaves):
        leaf = segs[-1]
        if len(segs) > 1:
            for row in rows:
                container(row, segs)
        entry = decoded[leaf_index]
        for row_index in entry["null_rows"]:
            container(rows[row_index], segs)[leaf] = None
        for value_index, row_index in enumerate(entry["slots"]):
            container(rows[row_index], segs)[leaf] = entry["values"][value_index]

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
        self._profile = copy.deepcopy(profile) if profile is not None else None
        self.artifact = serialize_artifact(ir, plan, self._profile)
        self._fp = fingerprint_of(self.artifact)
        self.fingerprint = self._fp.hex()
        self._limits = limits
        if pack is False:
            deflate = inflate = None
        elif pack is None:
            deflate, inflate = _default_deflate, _default_inflate
        else:
            deflate, inflate = pack.get("deflate"), pack.get("inflate")
        self._ctx = _Ctx(limits, plan == "columnar", deflate, inflate, self._profile)

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
