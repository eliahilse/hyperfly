import time
import tracemalloc

import pytest

from conftest import load
from hyperfly import HyperflyError, Limits, compile_ir
from test_limits import codec_for, revive
from test_vectors import deep_eq

BYTES = load("bytes.json")


def test_every_section_is_covered():
    assert set(BYTES) == {"description", "valid", "invalidDecode", "invalidEncode", "packedDecode"}


@pytest.mark.parametrize("vector", BYTES["valid"], ids=lambda v: v["name"])
def test_valid(vector):
    codec = codec_for(vector)
    value = revive(vector["value"])
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), value)
    assert codec.encode_body(value).hex() == vector["hex"]


@pytest.mark.parametrize("vector", BYTES["invalidDecode"], ids=lambda v: v["name"])
def test_invalid_decode(vector):
    with pytest.raises(HyperflyError) as err:
        codec_for(vector).decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"]


@pytest.mark.parametrize("vector", BYTES["invalidEncode"], ids=lambda v: v["name"])
def test_invalid_encode(vector):
    codec = codec_for(vector)
    value = revive(vector["value"])
    for encode in (codec.encode_body, codec.encode):
        with pytest.raises(HyperflyError) as err:
            encode(value)
        assert err.value.code == vector["error"]


@pytest.mark.parametrize("vector", BYTES["packedDecode"], ids=lambda v: v["name"])
def test_packed_decode(vector):
    assert deep_eq(codec_for(vector).decode_body(bytes.fromhex(vector["hex"])), revive(vector["value"]))


def _array(*fields):
    return {"kind": "array", "element": {"kind": "struct", "fields": list(fields)}}


def _field(name, kind, **options):
    return {"name": name, "type": {"kind": kind, **options}}


def _profile(*columns):
    return {"version": 2, "shared": {"columns": list(columns)}}


def _code(ir, body, total, plan="columnar", profile=None, pack=None):
    codec = compile_ir(ir, plan=plan, profile=profile, pack=pack, limits=Limits(max_total_bytes=total))
    try:
        codec.decode_body(bytes.fromhex(body))
    except HyperflyError as err:
        return err.code
    return "ok"


STRING = _array(_field("a", "string"))


@pytest.mark.parametrize("kind", ["string", "bytes"])
def test_length_prefixes_are_charged_before_their_bytes(kind):
    assert _code({"kind": kind}, "02", 1, plan="row") == "limit"
    assert _code({"kind": kind}, "01", 1, plan="row") == "truncated"
    body = "010002" if kind == "string" else "0102"
    assert _code(_array(_field("a", kind)), body, 1) == "limit"
    assert _code(_array(_field("a", kind)), body, 2) == "truncated"


# rows abcdefghij (code 1), k (code 2), zz (escape), abcdefghij: 10, 1, 2 and 10 decoded bytes
DICT = _profile({"leaf": 0, "dict": ["abcdefghij", "k"]})


@pytest.mark.parametrize(
    "body, total, code",
    [
        ("04010249027a7a", 23, "ok"),
        ("04010249027a7a", 22, "limit"),
        # code 3 at row 3 is out of range: the budget passed at the escape in row 2 decides first
        ("040102c9027a7a", 12, "limit"),
        ("040102c9027a7a", 13, "range"),
        # the escape's declared length is charged before its missing bytes are read
        ("040102c9027a", 12, "limit"),
        ("040102c9027a", 13, "truncated"),
        ("040102c902ff7a", 13, "utf8"),
        ("040102c902ff7a", 12, "limit"),
        # padding is structure, read before any value
        ("03010289027a7a", 0, "bitmap"),
    ],
)
def test_dictionary_values_are_charged_in_row_order(body, total, code):
    assert _code(STRING, body, total, profile=DICT) == code


# ord_ and one hex digit renders five bytes per matched row
ORD = _profile({"leaf": 0, "grammar": [{"lit": "ord_"}, {"num": {"base": 16, "len": 1, "case": "lower"}}]})


@pytest.mark.parametrize(
    "body",
    ["02030000" "0010", "02030001" "0020", "02030002" "00050002", "02030003" "002000", "02030004" "00000502" "10"],
)
def test_grammar_charges_rendered_lengths_before_lane_ranges_of_later_rows(body):
    assert _code(STRING, body, 4, profile=ORD) == "limit"


@pytest.mark.parametrize(
    "body, code",
    [
        # a value's own range check comes before its charge
        ("0203000010" "00", "range"),
        # lanes are structure: a short lane fails before any value is checked
        ("0203000010", "truncated"),
        ("0203000200050080", "bitmap"),
        ("0203010100" "1001ff", "utf8"),
    ],
)
def test_grammar_lane_structure_and_value_checks(body, code):
    assert _code(STRING, body, 4, profile=ORD) == code


@pytest.mark.parametrize(
    "body, total, code",
    [
        # ord_1, the escape q, ord_2: 11 bytes
        ("030301020001020171", 11, "ok"),
        ("030301020001020171", 10, "limit"),
        # ord_g at row 2 is out of range: the escape in row 1 passes a budget of 5 first
        ("030301020001100171", 5, "limit"),
        ("030301020001100171", 6, "range"),
        ("030301020001100171", 10, "range"),
    ],
)
def test_grammar_escapes_and_matches_share_row_order(body, total, code):
    assert _code(STRING, body, total, profile=ORD) == code


TWO = _array(_field("a", "string"), _field("b", "string"))
DERIVED = _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": ["yyyyyyyy"]}})


@pytest.mark.parametrize(
    "body, total, code",
    [
        ("030101070400", 27, "ok"),
        ("030101070400", 26, "limit"),
        # row 2's source is the escape z, outside the dictionary: rows 0 and 1 charge 16 bytes first
        ("03010103017a0400", 18, "limit"),
        ("03010103017a0400", 19, "range"),
    ],
)
def test_derived_values_are_charged_when_resolved(body, total, code):
    assert _code(TWO, body, total, profile=DERIVED) == code


ENUM = _array(_field("a", "enum", members=["abcdefghijklmnop", "q", "r"]))


def test_enum_column_charges_members_in_row_order():
    assert _code(ENUM, "020c", 15) == "limit"
    assert _code(ENUM, "0203", 15) == "range"
    assert _code(ENUM, "020c", 16) == "range"


def test_literals_are_charged_each_time_they_decode():
    literal = {"kind": "literal", "value": "été"}
    assert _code({"kind": "array", "element": literal}, "02", 10, plan="row") == "ok"
    assert _code({"kind": "array", "element": literal}, "02", 9, plan="row") == "limit"
    leaf = _array({"name": "a", "type": literal}, _field("b", "bool"))
    assert _code(leaf, "0200", 10) == "ok"
    assert _code(leaf, "0200", 9) == "limit"
    assert _code(_array(_field("a", "literal", value=7)), "05", 0) == "ok"


PACKED = "0302282828064b4c1c180000"


def test_packed_total_is_charged_before_the_blob_and_before_unsupported():
    assert _code(STRING, PACKED, 120) == "ok"
    assert _code(STRING, PACKED, 119) == "limit"
    assert _code(STRING, PACKED[:-4], 119) == "limit"
    assert _code(STRING, PACKED[:-4], 120) == "truncated"
    assert _code(STRING, PACKED, 119, pack=False) == "limit"
    assert _code(STRING, PACKED, 120, pack=False) == "unsupported"


ZERO = {
    "kind": "struct",
    "fields": [
        _field("a", "literal", value=None),
        _field("b", "literal", value=True),
        _field("c", "literal", value=7),
        _field("d", "int"),
        _field("e", "bool"),
        _field("f", "float64"),
        _field("g", "string"),
        _field("h", "bytes"),
        _field("i", "literal", value=""),
    ],
}


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_zero_byte_budget_accepts_empty_values(plan):
    codec = compile_ir(ZERO, plan=plan, limits=Limits(max_total_bytes=0, max_byte_amplification=0))
    value = {"a": None, "b": True, "c": 7, "d": 42, "e": False, "f": 1.5, "g": "", "h": b"", "i": ""}
    assert codec.decode(codec.encode(value)) == value
    with pytest.raises(HyperflyError) as err:
        codec.encode({**value, "g": "a"})
    assert err.value.code == "limit"


def test_byte_amplification_is_measured_on_the_final_body():
    # one body byte, so 2 x the amplification may decode: eight bytes need 4
    ir = {"kind": "enum", "members": ["abcdefgh"]}
    exact = compile_ir(ir, limits=Limits(max_byte_amplification=4))
    assert exact.encode_body("abcdefgh") == b"\x00"
    assert exact.decode_body(b"\x00") == "abcdefgh"
    short = compile_ir(ir, limits=Limits(max_byte_amplification=3))
    for run in (lambda: short.encode_body("abcdefgh"), lambda: short.decode_body(b"\x00")):
        with pytest.raises(HyperflyError) as err:
            run()
        assert err.value.code == "limit"
    huge = compile_ir({"kind": "string"}, limits=Limits(max_total_bytes=2**53 - 1, max_byte_amplification=2**53 - 1))
    assert huge.decode_body(huge.encode_body("ab")) == "ab"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_encoder_counts_what_the_decoder_charges(plan):
    ir = _array(
        _field("s", "string"),
        _field("e", "enum", members=["é", "f"]),
        _field("l", "literal", value="ab"),
        _field("b", "bytes"),
    )
    value = [{"s": "xé", "e": "é", "l": "ab", "b": b"\x00"}] * 3
    body = compile_ir(ir, plan=plan).encode_body(value)
    decoded = 3 * (3 + 2 + 2 + 1)
    exact = compile_ir(ir, plan=plan, limits=Limits(max_total_bytes=decoded))
    assert exact.encode_body(value) == body
    assert exact.decode_body(body) == value
    short = compile_ir(ir, plan=plan, limits=Limits(max_total_bytes=decoded - 1))
    for run in (lambda: short.encode_body(value), lambda: short.decode_body(body)):
        with pytest.raises(HyperflyError) as err:
            run()
        assert err.value.code == "limit"


ROWS_400K = "80b518"
LONG = "x" * 1000

# bodies under 64 KB whose values decode to far more than 64 bytes per body byte
HOSTILE = [
    ("dictionary hits", TWO, _profile({"leaf": 0, "dict": [LONG]}), ROWS_400K + "0101" + "ff" * 50000),
    (
        "grammar renders",
        STRING,
        _profile({"leaf": 0, "grammar": [{"lit": LONG}, {"num": {"base": 10, "len": 8, "case": "lower"}}]}),
        ROWS_400K + "0300020000" + "00" * 12500,
    ),
    (
        "derived values",
        TWO,
        _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": [LONG]}}),
        ROWS_400K + "0101" + "ff" * 50000 + "0400",
    ),
    ("enum members", _array(_field("a", "enum", members=[LONG])), None, "c0843d" + "00" * 31250),
    ("enum members by index", _array(_field("a", "enum", members=[LONG, "y" * 1000])), None, ROWS_400K + "00" * 50000),
    ("literal leaf", _array(_field("a", "literal", value=LONG)), None, "c0843d" + "00" * 31250),
    ("packed total", STRING, None, "a09c0102" + "e807" * 20000),
]


@pytest.mark.parametrize("ir, profile, body", [case[1:] for case in HOSTILE], ids=[case[0] for case in HOSTILE])
def test_hostile_bodies_exceed_the_byte_budget_fast_and_small(ir, profile, body):
    _assert_fast_limit(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body))


def test_hostile_literal_repetition_in_the_row_plan():
    codec = compile_ir({"kind": "array", "element": {"kind": "literal", "value": LONG}})
    _assert_fast_limit(codec, bytes.fromhex("c0843d") + bytes(31250))


def _assert_fast_limit(codec, body):
    assert len(body) < 64 * 1024
    start = time.perf_counter()
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(body)
    elapsed = time.perf_counter() - start
    tracemalloc.start()
    try:
        with pytest.raises(HyperflyError):
            codec.decode_body(body)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert err.value.code == "limit"
    assert "byte budget" in str(err.value)
    assert elapsed < 0.2
    assert peak < 8 << 20


LANE = {"num": {"base": 10, "len": 1, "case": "lower"}}
CHAIN = _profile(
    {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
    {"leaf": 1, "dict": ["x", "y"], "derived": {"source": 0, "values": ["x", "y"]}},
    {"leaf": 2, "derived": {"source": 1, "values": ["p", "q"]}},
    {"leaf": 3, "derived": {"source": 1, "values": ["p", "q"]}},
)


@pytest.mark.parametrize("count", [1, 9, 300])
def test_derived_columns_share_their_sources(count):
    ir = _array(*(_field(name, "string") for name in "sabc"))
    codec = compile_ir(ir, plan="columnar", profile=CHAIN)
    rows = []
    for i in range(count):
        s = ["00", "10", "37"][i % 3] if i % 11 else "zz"
        a = {"00": "x", "10": "y"}.get(s, "w") if i % 7 else "v"
        b = {"x": "p", "y": "q"}.get(a, "o")
        rows.append({"s": s, "a": a, "b": b, "c": b if i % 5 else "n"})
    body = codec.encode_body(rows)
    assert codec.decode_body(body) == rows
    assert codec.encode_body(codec.decode_body(body)) == body


GRAMMAR_SOURCE = _profile(
    {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
    {"leaf": 1, "derived": {"source": 0, "values": ["x", "y"]}},
)
OPTIONAL_SOURCE = _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": ["y"]}})
OPTIONAL_PAIR = _array({"name": "s", "type": {"kind": "string"}, "optional": True}, _field("d", "string"))


@pytest.mark.parametrize(
    "ir, profile, body, expected",
    [
        # s renders 00 and 10 from one varying lane, so d derives x and y
        (TWO, GRAMMAR_SOURCE, "02" "0300" "02000204" "020000" "0400", [{"a": "00", "b": "x"}, {"a": "10", "b": "y"}]),
        # 30 matches the grammar but not the dictionary
        (TWO, GRAMMAR_SOURCE, "02" "0300" "0200020c" "020000" "0400", "range"),
        # the escape z is outside the dictionary
        (TWO, DERIVED, "02" "010101017a" "0400", "range"),
        (OPTIONAL_PAIR, OPTIONAL_SOURCE, "02" "03" "010103" "0400", [{"s": "x", "d": "y"}, {"s": "x", "d": "y"}]),
        # s is absent from row 1
        (OPTIONAL_PAIR, OPTIONAL_SOURCE, "02" "01" "010101" "0400", "range"),
    ],
)
def test_derived_sources_outside_the_dictionary(ir, profile, body, expected):
    codec = compile_ir(ir, plan="columnar", profile=profile)
    if isinstance(expected, list):
        assert codec.decode_body(bytes.fromhex(body)) == expected
        return
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(body))
    assert err.value.code == expected
