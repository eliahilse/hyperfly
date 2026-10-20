import dataclasses
import tracemalloc

import pytest

from conftest import calls, load
from hyperfly import HyperflyError, Limits, compile_ir
from test_vectors import deep_eq, revive

LIMITS = load("limits.json")

FIELDS = {
    "maxDepth": "max_depth",
    "maxItems": "max_items",
    "maxByteLength": "max_byte_length",
    "maxAmplification": "max_amplification",
    "maxTotalItems": "max_total_items",
    "maxTotalBytes": "max_total_bytes",
    "maxByteAmplification": "max_byte_amplification",
}
KEYS = {"name", "description", "plan", "ir", "limits", "profile", "inflate", "value", "hex", "error"}


def codec_for(vector):
    assert set(vector) <= KEYS, set(vector) - KEYS
    overrides = {FIELDS[key]: value for key, value in vector.get("limits", {}).items()}
    limits = dataclasses.replace(Limits(), **overrides)
    pack = None if vector.get("inflate", True) else False
    return compile_ir(vector["ir"], plan=vector["plan"], limits=limits, pack=pack, profile=vector.get("profile"))


def test_every_section_is_covered():
    assert set(LIMITS) == {"description", "valid", "invalidDecode", "invalidEncode", "decodeOnly"}


@pytest.mark.parametrize("vector", LIMITS["valid"], ids=lambda v: v["name"])
def test_valid(vector):
    codec = codec_for(vector)
    value = revive(vector["value"])
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), value)
    assert codec.encode_body(value).hex() == vector["hex"]


@pytest.mark.parametrize("vector", LIMITS["invalidDecode"], ids=lambda v: v["name"])
def test_invalid_decode(vector):
    with pytest.raises(HyperflyError) as err:
        codec_for(vector).decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"]


@pytest.mark.parametrize("vector", LIMITS["invalidEncode"], ids=lambda v: v["name"])
def test_invalid_encode(vector):
    with pytest.raises(HyperflyError) as err:
        codec_for(vector).encode_body(revive(vector["value"]))
    assert err.value.code == vector["error"]


@pytest.mark.parametrize("vector", LIMITS["decodeOnly"], ids=lambda v: v["name"])
def test_decode_only(vector):
    codec = codec_for(vector)
    value = revive(vector["value"])
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), value)
    with pytest.raises(HyperflyError) as err:
        codec.encode_body(value)
    assert err.value.code == "limit"


def test_defaults_match_the_spec():
    assert Limits().max_amplification == 32
    assert Limits().max_total_items == 2**24
    assert Limits().max_total_bytes == 2**26
    assert Limits().max_byte_amplification == 64


TWO_INTS = {
    "kind": "array",
    "element": {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": {"kind": "int", "max": 15}},
            {"name": "b", "type": {"kind": "int"}},
        ],
    },
}


def _array(*fields):
    return {"kind": "array", "element": {"kind": "struct", "fields": list(fields)}}


def _field(name, kind, **options):
    flags = {key: options.pop(key) for key in ("optional", "nullable") if key in options}
    return {"name": name, "type": {"kind": kind, **options}, **flags}


def _profile(*columns):
    return {"version": 2, "shared": {"columns": list(columns)}}


B = _field("b", "int")
DICT_X = _profile({"leaf": 0, "dict": ["x"]})
ROWS_400K = "80b518"

# Bodies under 64 KB from the #47 reviews: each declares up to 1.5M rows that cost
# next to nothing until a later column is malformed
HOSTILE = [
    (
        "escaped grammar",
        _array(_field("a", "string"), B),
        _profile(
            {
                "leaf": 0,
                "grammar": [{"lit": "x" * 1000}, {"num": {"base": 10, "len": 8, "case": "lower"}}],
            }
        ),
        "a08d06030101" + "00" * 12499 + "0200000178ff",
        "marker",
    ),
    (
        "width-zero delta out of bounds at the end",
        _array(_field("a", "int", max=1499998), B),
        None,
        "e0c65b03000200ff" + "00" * 60000,
        "range",
    ),
    (
        "width-zero delta out of the domain",
        _array(_field("a", "int")),
        None,
        "c0843d0382f785ffffffff1f0200" + "00" * 32000,
        "range",
    ),
    ("optional literal", _array(_field("a", "literal", value="x", optional=True), B), None, "80a61d" + "ff" * 60001, "marker"),
    ("int frame", _array(_field("a", "int"), B), None, ROWS_400K + "020001" + "00" * 50000 + "ff", "marker"),
    ("int frame at an offset", _array(_field("a", "int"), B), None, "80a61d02d00f01" + "00" * 60000 + "ff", "marker"),
    ("patched frame", _array(_field("a", "int"), B), None, ROWS_400K + "04000001" + "00" * 50000 + "ff", "marker"),
    (
        "optional width-zero frame",
        _array(_field("a", "int", optional=True), B),
        None,
        ROWS_400K + "ff" * 50000 + "020000ff",
        "marker",
    ),
    ("bool bitmap", _array(_field("a", "bool"), B), None, ROWS_400K + "00" * 50000 + "ff", "marker"),
    ("enum", _array(_field("a", "enum", members=["p", "q"]), B), None, ROWS_400K + "00" * 50000 + "ff", "marker"),
    ("dictionary codes", _array(_field("a", "string"), B), DICT_X, ROWS_400K + "0101" + "ff" * 50001, "marker"),
    (
        "grammar lane",
        _array(_field("a", "string"), B),
        _profile({"leaf": 0, "grammar": [{"lit": "id-"}, {"num": {"base": 10, "len": 6, "case": "lower"}}]}),
        ROWS_400K + "0300020001" + "00" * 50000 + "ff",
        "marker",
    ),
    (
        "derived from a dictionary",
        _array(_field("a", "string"), _field("c", "string"), B),
        _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": ["y"]}}),
        ROWS_400K + "0101" + "ff" * 50000 + "0400ff",
        "marker",
    ),
    ("plain strings", _array(_field("a", "string"), B), None, "e0d40300" + "00" * 60000 + "ff", "marker"),
    ("bytes", _array(_field("a", "bytes"), B), None, "e0d403" + "00" * 60000 + "ff", "marker"),
    (
        "zero-bit row elements",
        {
            "kind": "struct",
            "fields": [
                {
                    "name": "a",
                    "type": {
                        "kind": "array",
                        "element": {
                            "kind": "struct",
                            "fields": [
                                {"name": "x", "type": {"kind": "literal", "value": "x"}},
                                {"name": "empty", "type": {"kind": "array", "element": {"kind": "int"}, "length": 0}},
                            ],
                        },
                    },
                },
                {"name": "b", "type": {"kind": "bool"}},
            ],
        },
        None,
        "a08d06ff" + "00" * 4000,
        "marker",
    ),
    (
        "six derived columns of one grammar source",
        _array(_field("s", "string"), *(_field(f"d{i}", "string") for i in range(6)), _field("n", "int")),
        _profile(
            {
                "leaf": 0,
                "dict": ["00", "10"],
                "grammar": [{"num": {"base": 10, "len": 1, "case": "lower"}}] * 2,
            },
            *({"leaf": i + 1, "derived": {"source": 0, "values": ["x", "y"]}} for i in range(6)),
        ),
        ROWS_400K + "0300020001" + "00" * 50000 + "020000" + "0400" * 6 + "ff",
        "marker",
    ),
]


@pytest.mark.parametrize("ir, profile, body, code", [case[1:] for case in HOSTILE], ids=[case[0] for case in HOSTILE])
def test_hostile_bodies_fail_fast_and_small(ir, profile, body, code):
    # these bodies target the item budget and column structure, so the byte budget stays out of the way
    codec = compile_ir(ir, plan="columnar", profile=profile, limits=Limits(max_total_bytes=2**40, max_byte_amplification=2**40))
    body = bytes.fromhex(body)
    assert len(body) < 64 * 1024
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(body)
    # each body declares far more rows than it has bytes: a step per row would show here
    def run():
        with pytest.raises(HyperflyError):
            codec.decode_body(body)

    assert calls(run) < 4 * len(body)
    tracemalloc.start()
    try:
        with pytest.raises(HyperflyError):
            codec.decode_body(body)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert err.value.code == code
    assert peak < 8 << 20


GRAMMAR_AB = _profile({"leaf": 0, "grammar": [{"lit": "ab"}, {"num": {"base": 10, "len": 2, "case": "lower"}}]})
DERIVED_Y = _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": ["y"]}})
STRING = _array(_field("a", "string"))
INT_TO_10 = _array(_field("a", "int", max=10))

# several defects in one body: the first one the per-value TypeScript decoder meets decides the code
FIRST_DEFECT = [
    ("dictionary code before a truncated escape", STRING, _profile({"leaf": 0, "dict": ["x", "y"]}), "0401020d", "range"),
    ("truncated escape before a dictionary code", STRING, _profile({"leaf": 0, "dict": ["x", "y"]}), "0401020c0561", "truncated"),
    ("invalid escape before a dictionary code", STRING, _profile({"leaf": 0, "dict": ["x", "y"]}), "0401020c01ff", "utf8"),
    ("invalid UTF-8 before truncation", STRING, None, "030001ff056162", "utf8"),
    ("invalid UTF-8 after a long value", STRING, None, "02008001" + "61" * 127 + "e201ff", "utf8"),
    ("long values before truncation", STRING, None, "03008001" + "e282ac" * 42 + "6101ff05", "truncated"),
    ("bound before a truncated delta", INT_TO_10, None, "0301140c", "range"),
    ("zero high part", INT_TO_10, None, "0304000101050501", "bitmap"),
    ("bound before a zero high part", _array(_field("a", "int", max=2)), None, "0304000101050501", "range"),
    ("missing derived source before an escape", _array(_field("a", "string"), _field("b", "string")), DERIVED_Y, "03010105017a04010405", "range"),
    ("escape before a missing derived source", _array(_field("a", "string"), _field("b", "string")), DERIVED_Y, "03010105017a04010105", "truncated"),
    ("grammar lane padding", STRING, GRAMMAR_AB, "030301010300020105", "bitmap"),
    ("negative zero before truncation", _array(_field("a", "float64")), None, "0200000000000000008000", "float"),
    ("mantissa before a bad varint", _array(_field("a", "float64")), None, "020300feffffffffffff7f8000", "range"),
    ("enum index late in the column", _array(_field("a", "enum", members=["a", "b", "c"])), None, "05e403", "range"),
    ("width-zero delta below min", _array(_field("a", "int", min=-3, max=3)), None, "0a03060100", "range"),
]


@pytest.mark.parametrize("ir, profile, body, code", [case[1:] for case in FIRST_DEFECT], ids=[case[0] for case in FIRST_DEFECT])
def test_first_defect_decides_the_code(ir, profile, body, code):
    codec = compile_ir(ir, plan="columnar", profile=profile)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(body))
    assert err.value.code == code


PARTIAL = _array(
    _field("kind", "string", optional=True),
    _field("email", "string", nullable=True),
    _field("n", "int", optional=True, nullable=True),
    _field("flag", "bool", optional=True),
    _field("e", "enum", members=[str(i) for i in range(9)], nullable=True),
)
PARTIAL_PROFILE = _profile(
    {"leaf": 0, "dict": ["alpha", "beta"]},
    {"leaf": 1, "derived": {"source": 0, "values": ["a@x", "b@x"]}},
)


@pytest.mark.parametrize("count", [1, 7, 8, 9, 300])
def test_columns_with_differing_participation_round_trip(count):
    codec = compile_ir(PARTIAL, plan="columnar", profile=PARTIAL_PROFILE)
    rows = []
    for i in range(count):
        row = {}
        if i % 3:
            row["kind"] = ["alpha", "beta", "gamma"][i % 4 % 3]
        row["email"] = None if i % 5 == 0 else ("a@x" if row.get("kind") == "alpha" and i % 7 else "z@y")
        if i % 2:
            row["n"] = None if i % 4 == 1 else 1000 + 3 * i
        if i % 4:
            row["flag"] = i % 3 == 0
        row["e"] = None if i % 6 == 0 else str(i % 9)
        rows.append(row)
    body = codec.encode_body(rows)
    decoded = codec.decode_body(body)
    assert deep_eq(decoded, rows)
    assert [list(row) for row in decoded] == [[k for k in ("kind", "email", "n", "flag", "e") if k in row] for row in rows]
    assert codec.encode_body(decoded) == body


def test_width_zero_column_stays_packed_until_every_column_decodes():
    codec = compile_ir(TWO_INTS, plan="columnar", limits=Limits(max_amplification=2**20))
    # one million rows: a is a width-zero frame, b carries an invalid mode byte
    body = bytes.fromhex("c0843d") + bytes([0x02, 0x00, 0x00, 0xFF])
    tracemalloc.start()
    try:
        with pytest.raises(HyperflyError) as err:
            codec.decode_body(body)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert err.value.code == "marker"
    assert peak < 1 << 20


@pytest.mark.parametrize("start, step", [(0, 3), (15, -3), (7, 0)])
def test_width_zero_delta_frame_round_trips(start, step):
    codec = compile_ir(TWO_INTS, plan="columnar")
    rows = [{"a": start + step * i, "b": 1} for i in range(6)]
    body = codec.encode_body(rows)
    assert codec.decode_body(body) == rows


def test_width_zero_delta_frame_checks_every_value():
    codec = compile_ir(TWO_INTS, plan="columnar")
    # 0, 3, ..., 15, 18: only the last value exceeds the declared max of 15
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex("070300060000020200"))
    assert err.value.code == "range"


def test_literal_elements_respect_max_depth():
    codec = compile_ir({"kind": "array", "element": {"kind": "literal", "value": "x"}}, limits=Limits(max_depth=0))
    assert codec.decode_body(b"\x00") == []
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(b"\x01")
    assert err.value.code == "depth"


PACKS_TO_NOTHING = {
    "kind": "array",
    "length": 2,
    "element": {"kind": "struct", "fields": [{"name": "e", "type": {"kind": "enum", "members": ["only"]}}]},
}


@pytest.mark.parametrize("count", [1, 9])
def test_encoder_holds_row_arrays_to_the_one_bit_floor(count):
    # the inner fixed columnar array is not zero-bit yet encodes to no bytes, so
    # the row-encoded outer array has nothing to pay its count with
    codec = compile_ir({"kind": "array", "element": PACKS_TO_NOTHING}, plan="columnar")
    with pytest.raises(HyperflyError) as encoded:
        codec.encode_body([[{"e": "only"}] * 2] * count)
    assert encoded.value.code == "limit"
    with pytest.raises(HyperflyError) as decoded:
        codec.decode_body(bytes([count]))
    assert decoded.value.code == "limit"
    assert codec.encode_body([]) == b"\x00"


def test_encoder_floor_counts_only_the_arrays_own_bytes():
    ir = {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": {"kind": "array", "element": PACKS_TO_NOTHING}},
            {"name": "b", "type": {"kind": "bytes"}},
        ],
    }
    codec = compile_ir(ir, plan="columnar")
    value = {"a": [[{"e": "only"}] * 2], "b": b"\xff"}
    assert codec.decode_body(bytes.fromhex("0101ff")) == value
    with pytest.raises(HyperflyError) as err:
        codec.encode_body(value)
    assert err.value.code == "limit"
