import tracemalloc
from array import array
from itertools import combinations, islice

import pytest

from conftest import calls, load
from hyperfly import HyperflyError, Limits, _codec, compile_ir
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


THREE_MEMBERS = {"kind": "enum", "members": ["a", "bb", "ccc"]}
NEG_ZERO, INFINITY = "0000000000000080", "000000000000f07f"


@pytest.mark.parametrize(
    "kind, body, total, outcome",
    [
        # a short column's values are read, checked and charged in row order
        ("string", "01008000", 64, "varint: overlong uvarint encoding"),
        ("string", "0200016104616263", 64, "limit: $[].a[1]: string length exceeds limit"),
        ("string", "020001ff0561", 64, "utf8: $[].a[0]: invalid UTF-8"),
        ("string", "020002616202ff62", 64, "utf8: $[].a[1]: invalid UTF-8"),
        ("string", "0200026162026364", 3, "limit: $[].a[1]: decoded bytes exceed the byte budget of 3"),
        ("string", "02000261620363", 3, "limit: $[].a[1]: decoded bytes exceed the byte budget of 3"),
        ("string", "02000261620363", 5, "truncated: unexpected end of input"),
        ("bytes", "028000", 64, "varint: overlong uvarint encoding"),
        ("bytes", "020161046162", 64, "limit: $[].a[1]: bytes length exceeds limit"),
        ({"kind": "int", "min": 0, "max": 5}, "02000980", 64, "range: $[].a[0]: above declared max"),
        ({"kind": "int", "min": 0, "max": 5}, "02000180", 64, "truncated: unexpected end of input"),
        ({"kind": "int", "min": 0, "max": 5}, "0301020303", 64, "range: $[].a[2]: below declared min"),
        ("float64", "02030280", 64, "truncated: unexpected end of input"),
        ("float64", "020302ffffffffffffff7f00", 64, "range: $[].a[0]: decimal mantissa outside the v0 domain"),
        ("float64", "02020202ffffffffffffff7f", 64, "range: $[].a[1]: decimal mantissa outside the v0 domain"),
        ("float64", "0200" + NEG_ZERO + INFINITY, 64, "float: $[].a[0]: negative-zero bit pattern"),
        ("float64", "0200" + "0000000000000040" + INFINITY, 64, "float: $[].a[1]: non-finite float64"),
        ("float64", "0200" + "0000000000000040" + "000000", 64, "truncated: unexpected end of input"),
        (THREE_MEMBERS, "0104", 64, "bitmap: $[].a: nonzero bit-packing padding"),
        (THREE_MEMBERS, "020d", 64, "range: $[].a[1]: enum index 3 out of range"),
        (THREE_MEMBERS, "0306", 3, "limit: $[].a[1]: decoded bytes exceed the byte budget of 3"),
        (THREE_MEMBERS, "0306", 5, "limit: $[].a[2]: decoded bytes exceed the byte budget of 5"),
        (THREE_MEMBERS, "0306", 6, "ok"),
    ],
)
def test_short_columns_fail_at_their_first_failing_value(kind, body, total, outcome):
    t = {"kind": kind} if isinstance(kind, str) else kind
    limits = Limits(max_byte_length=3, max_total_bytes=total, max_byte_amplification=2**40)
    codec = compile_ir(_array({"name": "a", "type": t}), plan="columnar", limits=limits)
    try:
        codec.decode_body(bytes.fromhex(body))
    except HyperflyError as err:
        assert f"{err.code}: {err}" == outcome
    else:
        assert outcome == "ok"


def test_a_short_column_of_a_long_value_defers_its_charge(readers):
    codec = compile_ir(_array(_field("a", "string"), _field("b", "string")), plan="columnar", pack=False)
    rows = [{"a": "x" * 1100, "b": "y"}]
    assert codec.decode_body(codec.encode_body(rows)) == rows
    budget = readers[-1].budget
    assert (budget.bytes, budget.owed) == (1, 1100)
    budget.settle()
    assert budget.bytes == 1101


@pytest.mark.parametrize(
    "row",
    [
        {"s": {"x": "p", "y": {"z": 1}}, "o": 2, "n": None},
        {"s": {"x": "", "y": {"z": -1}}, "n": 1.5},
    ],
)
def test_one_row_nests_and_drops_absent_fields(row):
    inner = {"kind": "struct", "fields": [_field("z", "int")]}
    nested = {"kind": "struct", "fields": [_field("x", "string"), {"name": "y", "type": inner}]}
    ir = _array({"name": "s", "type": nested}, dict(_field("o", "int"), optional=True), dict(_field("n", "float64"), nullable=True))
    codec = compile_ir(ir, plan="columnar")
    decoded = codec.decode_body(codec.encode_body([row]))
    assert decoded == [row] and list(decoded[0]) == list(row)


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
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(body)
    # each body declares far more rows than it has bytes: a step per row would show here
    assert calls(_rejects(codec, body, "limit")) < 4 * len(body)
    tracemalloc.start()
    try:
        with pytest.raises(HyperflyError):
            codec.decode_body(body)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert err.value.code == "limit"
    assert "byte budget" in str(err.value)
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


def _nested(*names):
    rows = {"kind": "array", "element": _array(*(_field(n, "string") for n in names))}
    return {"kind": "struct", "fields": [{"name": "rows", "type": rows}, _field("end", "bool")]}


def _derived_table(size):
    entries = ["s"] + [f"f{i}" for i in range(size - 1)]
    return (
        _nested("a", "b", "c"),
        _profile(
            {"leaf": 0, "dict": entries},
            {"leaf": 1, "dict": ["x"], "derived": {"source": 0, "values": ["x"] * size}},
            {"leaf": 2, "derived": {"source": 1, "values": ["y"]}},
        ),
        "a01f" + "0101010104000400" * 4000 + "ff",
    )


def _lane_table(digits):
    return (
        _nested("s", "d"),
        _profile(
            {"leaf": 0, "dict": ["0" * digits], "grammar": [{"num": {"base": 16, "len": digits, "case": "lower"}}]},
            {"leaf": 1, "derived": {"source": 0, "values": ["x"]}},
        ),
        "a01f" + "010300020001000400" * 4000 + "ff",
    )


def _derived_fanout(k):
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
        *({"leaf": i + 1, "derived": {"source": 0, "values": ["x", "y"]}} for i in range(k)),
    )
    ir = _array(_field("s", "string"), *(_field(f"d{i}", "string") for i in range(k)), _field("n", "int"))
    return ir, profile, ROWS_400K + "0300020001" + "00" * 50000 + "020000" + "0400" * k + "ff"


def _chain(fillers, lanes="00"):
    names = [f"filler{i}" for i in range(fillers)]
    return (
        _array(*(_field(f"s{i}", "string") for i in range(7)), _field("n", "int")),
        _profile(
            {"leaf": 0, "dict": names + ["00", "10"], "grammar": [LANE, LANE]},
            *(
                {"leaf": i, "dict": names + ["x", "y"], "derived": {"source": i - 1, "values": ["x"] * (fillers + 1) + ["y"]}}
                for i in range(1, 7)
            ),
        ),
        ROWS_400K + "0300020001" + lanes * 50000 + "020000" + "0400" * 6 + "ff",
    )


FILLERS = [f"filler{i}" for i in range(298)]
# codes 299 and 300 need two bytes; codes 99 and 100 fit one
TWO_BYTE_CHAIN = _chain(298)
ONE_BYTE_CHAIN = _chain(98)
# rows alternate 00 and 10, codes 255 and 256 at every link
STRADDLING_CHAIN = _chain(254, "aa")


def _nested_derived(values):
    # 4,000 nested arrays of one row, each with a derived column over a 255-entry dictionary
    ir = _nested("a", "b")
    profile = _profile(
        {"leaf": 0, "dict": ["s"] + [f"f{i}" for i in range(254)]},
        {"leaf": 1, "derived": {"source": 0, "values": values}},
    )
    return ir, profile, "a01f" + "010101010400" * 4000 + "ff"

# bodies whose cost could scale with a profile's dictionary or grammar domain, or with
# the number of derived columns, rather than with the body, each against the same body
# under a small profile: the bytes each decodes to before its last column fails, the
# calls allowed beyond 1.35 times the small profile's (two-byte codes take a translate
# per high byte, which one-byte codes do not), or None when the columns differ
COST_PAIRS = [
    ("dictionary size", _derived_table(16383), _derived_table(2), (12000, 12000), 8192),
    ("grammar domain", _lane_table(4), _lane_table(1), (20000, 8000), 8192),
    ("derived fan-out", _derived_fanout(6), _derived_fanout(1), (3200000, 1200000), None),
    ("two-byte codes", TWO_BYTE_CHAIN, ONE_BYTE_CHAIN, (3200000, 3200000), 16384),
    ("two-byte codes across a high byte", STRADDLING_CHAIN, _chain(98, "aa"), (3200000, 3200000), 16384),
    ("non-uniform derived values", _nested_derived(["x"] * 254 + ["yy"]), _nested_derived(["x"] * 255), (8000, 8000), 8192),
]


def _rejects(codec, body, code="marker"):
    def run():
        with pytest.raises(HyperflyError) as err:
            codec.decode_body(body)
        assert err.value.code == code

    return run


@pytest.fixture
def readers(monkeypatch):
    """Every Reader a decode makes, so a test can read its budgets afterwards."""
    made = []

    class Recorded(_codec.Reader):
        def __init__(self, *args):
            super().__init__(*args)
            made.append(self)

    monkeypatch.setattr(_codec, "Reader", Recorded)
    return made


def _decode(case, readers, code="marker"):
    """The error a case's body fails with, and its reader's items and decoded bytes."""
    ir, profile, body = case
    codec = compile_ir(ir, plan="columnar", profile=profile)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(body))
    assert err.value.code == code
    budget = readers[-1].budget
    budget.settle()
    return str(err.value), budget.total, budget.bytes


@pytest.mark.parametrize(
    "large, small, decoded, extra", [case[1:] for case in COST_PAIRS], ids=[case[0] for case in COST_PAIRS]
)
def test_cost_follows_the_body_not_the_profile(large, small, decoded, extra, readers):
    # both fail at the same place, having charged the same items and the bytes their
    # values decode to; with the same columns, they make about the same calls
    outcomes = [_decode(case, readers) for case in (large, small)]
    assert outcomes[0][:2] == outcomes[1][:2]
    assert (outcomes[0][2], outcomes[1][2]) == decoded
    if extra is not None:
        counts = [
            calls(_rejects(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body)))
            for ir, profile, body in (large, small)
        ]
        assert counts[0] < 1.35 * counts[1] + extra


@pytest.fixture
def spied(monkeypatch):
    """Counts of the helpers whose work could follow a profile's domain or the number of
    derived columns: every table _recode is handed with the rows it serves and whether
    it answered in bulk, source tallies, run-wise sums, source tallies taken in runs and
    the runs they count, masked translates, rows looked up one at a time through a
    derivation, and grammar code lookups."""
    seen = {
        "recode": [],
        "tally": 0,
        "runs": 0,
        "tally runs": 0,
        "counted": 0,
        "split": 0,
        "per row": 0,
        "grammar codes": 0,
    }

    def wrap(name, record):
        original = getattr(_codec, name)

        def spy(*args, **kwargs):
            result = original(*args, **kwargs)
            record(args, result)
            return result

        monkeypatch.setattr(_codec, name, spy)

    def recode(args, result):
        values, table = args
        rows = len(values) if hasattr(values, "__len__") else None
        seen["recode"].append((len(table), rows, type(result) is array))

    def count(key):
        return lambda args, result: seen.__setitem__(key, seen[key] + 1)

    wrap("_recode", recode)
    wrap("_tally", count("tally"))
    wrap("_run_sums", count("runs"))
    wrap("_tally_runs", count("tally runs"))
    wrap("_count_into", count("counted"))
    wrap("_translate_split", count("split"))
    wrap("_derived_code", count("per row"))
    grammar_codes = _codec._Ctx.grammar_codes

    def counted(self, *args):
        seen["grammar codes"] += 1
        return grammar_codes(self, *args)

    monkeypatch.setattr(_codec._Ctx, "grammar_codes", counted)
    return seen


def _decode_with(case, code="marker", limits=None):
    ir, profile, body = case
    codec = compile_ir(ir, plan="columnar", profile=profile, limits=limits)
    _rejects(codec, bytes.fromhex(body) if isinstance(body, str) else body, code)()
    return codec


LOOKUP_CASES = [
    ("dictionary size", _derived_table(16383)),
    ("dictionary size, 8,000 arrays", (*_derived_table(16383)[:2], "c03e" + "0101010104000400" * 8000 + "ff")),
    ("grammar domain", _lane_table(4)),
    ("two-byte codes", TWO_BYTE_CHAIN),
    ("two-byte codes across a high byte", STRADDLING_CHAIN),
]


@pytest.mark.parametrize("case", [case[1] for case in LOOKUP_CASES], ids=[case[0] for case in LOOKUP_CASES])
def test_lookups_follow_the_rows(case, spied):
    codec = _decode_with(case)
    for size, rows, bulk in spied["recode"]:
        # no table larger than the rows it serves, and no long run answered row by row
        assert rows is None or size <= max(4 * rows, 256)
        assert rows is None or rows < 256 or bulk
    if case is STRADDLING_CHAIN:
        # the five derived columns another derives from, each over codes 255 and 256
        assert spied["split"] == 5
    if case[1] == LOOKUP_CASES[0][1][1]:
        # one row per nested array never pays for the 16,383-entry recoding table
        assert not codec._ctx.recodings
        assert spied["per row"] == len(case[2]) // 16


@pytest.mark.parametrize("k", [1, 2, 6, 8])
def test_derived_columns_read_their_source_once(k, spied):
    # eight one-byte values over 400,000 rows pass the budget before the int column
    _decode_with(_derived_fanout(k), "limit" if k == 8 else "marker")
    assert spied["grammar codes"] == 1
    assert spied["runs"] == 0


def _derived_chain(k):
    # a grammar source, a dictionary column derived from it, and k columns derived from that
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
        {"leaf": 1, "dict": ["x", "y"], "derived": {"source": 0, "values": ["x", "y"]}},
        *({"leaf": i + 2, "derived": {"source": 1, "values": ["p", "q"]}} for i in range(k)),
    )
    ir = _array(*(_field(n, "string") for n in ["s"] + [f"d{i}" for i in range(k + 1)]), _field("n", "int"))
    return ir, profile, ROWS_400K + "0300020001" + "00" * 50000 + "020000" + "0400" * (k + 1) + "ff"


@pytest.mark.parametrize("k", [1, 2, 6])
def test_derived_chains_read_each_source_once(k, spied):
    _decode_with(_derived_chain(k), "limit" if k == 6 else "marker")
    assert spied["grammar codes"] == 1
    # the grammar source's codes, then the dictionary column's, each recoded once
    assert len(spied["recode"]) == 2


def _muse_nested(values):
    inner = _array(_field("a", "string"), _field("b", "string"))
    ir = _array({"name": "inner", "type": inner}, _field("end", "bool"))
    profile = _profile(
        {"leaf": 0, "dict": [f"s{i}" for i in range(255)]},
        {"leaf": 1, "dict": ["x", "yy"], "derived": {"source": 0, "values": values}},
    )
    body = compile_ir(ir, plan="columnar", profile=profile).encode_body([{"inner": [{"a": "s0", "b": "x"}], "end": False}] * 4000)
    return ir, profile, body[:-1] + b"\xff"


@pytest.mark.parametrize(
    "case",
    [_nested_derived(["x"] * 254 + ["yy"]), _nested_derived(["x"] * 255), _muse_nested(["x", "yy"] * 127 + ["x"]), _muse_nested(["x"] * 255)],
    ids=["non-uniform", "uniform", "non-uniform, dictionary target", "uniform, dictionary target"],
)
def test_short_derived_columns_take_no_tally(case, spied):
    _decode_with(case)
    assert spied["tally"] == 0
    assert spied["runs"] == 0


def test_an_early_overflow_takes_no_tally(spied):
    # 3,668 kilobyte values pass the budget long before the end of 524,000 rows
    ir = _array(_field("s", "string"), _field("d", "string"), _field("n", "int"))
    profile = _profile(
        {"leaf": 0, "dict": ["s"] + [f"f{i}" for i in range(254)]},
        {"leaf": 1, "derived": {"source": 0, "values": ["x" * 1000] + ["y" * 1001] * 254}},
    )
    codec = compile_ir(ir, plan="columnar", profile=profile)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex("e0fd1f0101" + "ff" * 65500 + "0400ff"))
    assert err.value.code == "limit" and "[].d[3668]" in str(err.value)
    assert spied["tally"] == 0
    assert spied["runs"] == 1


def _sparse_fanout(k, values, fillers=0):
    # 100,000 rows, one in 800 rendering 10 rather than 00: each consumer's bound passes
    # the budget though its values fit it
    ir = _array(*(_field(n, "string") for n in ["s"] + [f"d{i}" for i in range(k)]), _field("n", "int"))
    names = [f"filler{i}" for i in range(fillers)]
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"] + names, "grammar": [LANE, LANE]},
        *({"leaf": i + 1, "derived": {"source": 0, "values": values + [""] * fillers}} for i in range(k)),
    )
    lanes = ("01" + "00" * 99) * 125
    return ir, profile, "a08d06" + "0300" + "020001" + lanes + "020000" + "0400" * k + "ff"


@pytest.mark.parametrize("k", [1, 6, 24, 96])
@pytest.mark.parametrize("values", [["", "y" * 10], ["", ""]], ids=["non-uniform", "uniform"])
@pytest.mark.parametrize("fillers", [0, 40], ids=["2 codes", "42 codes"])
def test_derived_fan_out_reads_its_source_once(k, values, fillers, spied):
    _decode_with(_sparse_fanout(k, values, fillers))
    assert spied["grammar codes"] == 1
    # the source's rows are read at most once to sum them and once to tally its codes,
    # whatever the number of consumers; a small dictionary's codes are counted instead
    assert spied["runs"] <= 1 and spied["tally"] <= 1
    if fillers == 0:
        assert spied["runs"] == 0


def _masked_fanout(k, distinct=True, rows=128):
    # rows of an optional grammar source alternating 00 and 10, each rendering an empty
    # value, then k optional consumers absent from two rows each: rows i and i + 1 for
    # consumer i, or rows 0 and 1 for all of them
    ir = _array(
        dict(_field("s", "string"), optional=True),
        *(dict(_field(f"d{i}", "string"), optional=True) for i in range(k)),
        _field("n", "int"),
    )
    values = ["", "", "y" * 10] + [""] * 39
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"] + [f"f{i}" for i in range(40)], "grammar": [LANE, LANE]},
        *({"leaf": i + 1, "derived": {"source": 0, "values": values}} for i in range(k)),
    )
    mask = rows // 8
    body = _uleb(rows).hex() + "ff" * mask + "0300020001" + "aa" * mask + "020000"
    for i in range(k):
        absent = (1 << i) | (1 << (i + 1)) if distinct else 3
        body += (((1 << rows) - 1) ^ absent).to_bytes(mask, "little").hex() + "0400"
    return ir, profile, body + "ff"


def _coded_masks(k, rows, entries, first, distinct=True):
    # rows of a dictionary source holding codes first to first + rows - 1, each rendering
    # an empty value, then k optional consumers absent from two rows each: a distinct
    # pair for each consumer, or rows 0 and 1 for all of them
    ir = _array(
        _field("s", "string"),
        *(dict(_field(f"d{i}", "string"), optional=True) for i in range(k)),
        _field("n", "int"),
    )
    values = ["y" * 10] * entries
    values[first - 1 : first - 1 + rows] = [""] * rows
    profile = _profile(
        {"leaf": 0, "dict": [f"s{i}" for i in range(entries)]},
        *({"leaf": i + 1, "derived": {"source": 0, "values": values}} for i in range(k)),
    )
    width = (first + rows - 1).bit_length()
    body = _uleb(rows) + bytearray([1, width])
    _codec._pack_bits(body, list(range(first, first + rows)), width)
    for a, b in islice(combinations(range(rows), 2), k) if distinct else [(0, 1)] * k:
        body += (((1 << rows) - 1) ^ (1 << a) ^ (1 << b)).to_bytes(rows // 8, "little") + b"\x04\x00"
    return ir, profile, bytes(body + b"\xff")


def _uleb(value):
    out = bytearray()
    _codec.write_uleb(out, value)
    return out


# each consumer's bound, 126 or 254 rows of up to 10 bytes, passes a 1,000-byte budget
SMALL = Limits(max_total_bytes=1000)

# consumers whose rows hold fewer codes than four times their sizes, though enough to
# share a tally: 126 rows against the 43 sizes of a grammar source and the 130 of a
# byte dictionary, and 254 against 1,016 two-byte sizes, exactly at that bound
SHORT_MASKS = {
    "grammar source": lambda k, distinct: (_masked_fanout(k, distinct), SMALL),
    "byte codes": lambda k, distinct: (_coded_masks(k, 128, 129, 1, distinct), SMALL),
    "two-byte codes": lambda k, distinct: (_coded_masks(k, 256, 1015, 256, distinct), Limits(max_total_bytes=3000)),
}


@pytest.mark.parametrize("k", [2, 6, 40])
def test_distinct_participation_takes_no_unused_tally(k, spied):
    # 254 rows, at least four times the 43 sizes
    _decode_with(_masked_fanout(k, rows=256), limits=SMALL)
    # each consumer's own rows are tallied once, as its charge, and nothing else is
    assert spied["tally"] == 0 and spied["runs"] == 0
    assert spied["tally runs"] == k


@pytest.mark.parametrize("k", [2, 6, 40])
@pytest.mark.parametrize("shape", list(SHORT_MASKS))
def test_distinct_short_participation_is_summed(k, shape, spied):
    case, limits = SHORT_MASKS[shape](k, True)
    _decode_with(case, limits=limits)
    # no consumer's rows are read by another, so each is summed in runs and none tallied
    assert spied["runs"] == k
    assert spied["tally"] == 0 and spied["tally runs"] == 0


@pytest.mark.parametrize("k", [2, 3, 6])
@pytest.mark.parametrize("shape", list(SHORT_MASKS))
def test_repeated_short_participation_is_tallied_once(k, shape, spied):
    case, limits = SHORT_MASKS[shape](k, False)
    _decode_with(case, limits=limits)
    # the first consumer sums its rows; the second tallies them, as its charge, for
    # every later one
    assert spied["runs"] == 1 and spied["tally runs"] == 1
    assert spied["tally"] == 0


@pytest.mark.parametrize("k", [2, 6])
@pytest.mark.parametrize("shape", ["masked", "sparse"])
def test_one_participation_reads_its_source_once(k, shape, spied):
    if shape == "masked":
        _decode_with(_masked_fanout(k, distinct=False, rows=256), limits=SMALL)
    else:
        _decode_with(_sparse_fanout(k, ["", "y" * 10], 40))
    assert spied["tally"] == 0 and spied["runs"] == 0
    assert spied["tally runs"] == 1


@pytest.mark.parametrize("second", ["uniform", "never read"])
def test_a_tally_is_taken_only_for_a_charge(second, spied):
    ir, profile, body = _sparse_fanout(2, ["", "y" * 10], 40)
    if second == "uniform":
        profile["shared"]["columns"][2]["derived"]["values"] = [""] * 42
    else:
        body = body[: -len("0400ff")] + "ff"
    _decode_with((ir, profile, body))
    # the first consumer's tally is its charge; the second needs none
    assert spied["tally"] == 0 and spied["runs"] == 0
    assert spied["tally runs"] == 1


def test_a_shared_early_overflow_takes_no_full_pass(spied):
    # two consumers of 524,000 rows of kilobyte values: the first passes the budget at
    # d[3668], within the first run of its tally
    ir = _array(_field("s", "string"), _field("d", "string"), _field("e", "string"), _field("n", "int"))
    values = ["x" * 1000] + ["y" * 1001] * 254
    profile = _profile(
        {"leaf": 0, "dict": ["s"] + [f"f{i}" for i in range(254)]},
        {"leaf": 1, "derived": {"source": 0, "values": values}},
        {"leaf": 2, "derived": {"source": 0, "values": values}},
    )
    codec = compile_ir(ir, plan="columnar", profile=profile)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex("e0fd1f0101" + "ff" * 65500 + "04000400ff"))
    assert err.value.code == "limit" and "[].d[3668]" in str(err.value)
    assert spied["tally"] == 0 and spied["runs"] == 0
    assert spied["tally runs"] == 1 and spied["counted"] == 1


def test_a_small_dictionary_early_overflow_takes_no_full_tally(spied):
    # two consumers of 100,000 rows over a 31-entry dictionary: the first passes the
    # budget at d[13268], within the fourth of its 25 runs, so its rows are not all counted
    ir = _array(_field("s", "string"), _field("d", "string"), _field("e", "string"), _field("n", "int"))
    values = ["y" * 10] * 30 + ["y" * 9]
    profile = _profile(
        {"leaf": 0, "dict": [f"w{i}" for i in range(31)]},
        {"leaf": 1, "derived": {"source": 0, "values": values}},
        {"leaf": 2, "derived": {"source": 0, "values": values}},
    )
    body = _uleb(100000) + bytearray([1, 5])
    _codec._pack_bits(body, [1 + i % 31 for i in range(100000)], 5)
    codec = compile_ir(ir, plan="columnar", profile=profile, limits=Limits(max_total_bytes=400000))
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes(body + b"\x04\x00\x04\x00\xff"))
    assert err.value.code == "limit" and "[].d[13268]" in str(err.value)
    assert spied["tally"] == 0 and spied["runs"] == 0
    assert spied["tally runs"] == 1


@pytest.mark.parametrize("k", [100, 200])
@pytest.mark.parametrize("shape", ["byte codes", "two-byte codes"])
@pytest.mark.parametrize("distinct", [True, False], ids=["distinct", "repeated"])
def test_deferred_short_participation_follows_the_charge(k, shape, distinct, spied):
    # default limits: each consumer's bound fits, so its total defers until the budget
    # settles it, as it does for most of them
    case, _limits = SHORT_MASKS[shape](k, distinct)
    _decode_with(case)
    assert spied["tally runs"] == 0
    if distinct:
        assert spied["tally"] == 0 and k // 2 < spied["runs"] <= k
    else:
        assert spied["tally"] == 1 and spied["runs"] == 0


def _compact_readers(flags, two_byte=False):
    # 1,024 rows of a grammar source, a dictionary column derived from it holding one
    # code at every row (code 1, or 301 with two-byte codes), then a column derived from
    # that per flag: "required", "optional" (present at every row) or "uniform" (required,
    # values of one length). The rows select an empty value; one unused value of 3,000
    # bytes takes each bound past the budget, and a dictionary of 257 or 302 sizes makes
    # the rows short
    names = [f"f{i}" for i in range(300)] + ["a"] if two_byte else ["a"] + [f"f{i}" for i in range(255)]
    values = [""] * len(names)
    values[0 if two_byte else -1] = "y" * 3000
    columns = [{"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]}, {"leaf": 1, "dict": names, "derived": {"source": 0, "values": ["a", "a"]}}]
    fields = [_field("root", "string"), _field("s", "string")]
    body = "8008" + "0300020001" + "aa" * 128 + "020000" + "0400"
    for i, flag in enumerate(flags):
        fields.append(dict(_field(f"d{i}", "string"), optional=True) if flag == "optional" else _field(f"d{i}", "string"))
        columns.append({"leaf": i + 2, "derived": {"source": 1, "values": [""] * len(names) if flag == "uniform" else values}})
        body += ("ff" * 128 if flag == "optional" else "") + "0400"
    return _array(*fields, _field("n", "int")), _profile(*columns), body + "ff"


@pytest.mark.parametrize("k", [2, 3])
@pytest.mark.parametrize("two_byte", [False, True], ids=["byte codes", "two-byte codes"])
def test_required_short_readers_tally_once(k, two_byte, spied):
    _decode_with(_compact_readers(["required"] * k, two_byte))
    # every reader reads the source at every row: the first tallies it, as its charge,
    # for the others
    assert spied["runs"] == 0 and spied["tally"] == 0
    assert spied["tally runs"] == 1


@pytest.mark.parametrize(
    "flags, runs, tallies",
    [
        (["required", "optional"], 2, 0),
        (["required", "required", "optional"], 1, 1),
        (["required", "optional", "optional"], 2, 1),
        (["required", "uniform"], 1, 0),
    ],
    ids=["required and optional", "two required and optional", "required and two optional", "required and uniform"],
)
def test_mixed_short_readers(flags, runs, tallies, spied):
    _decode_with(_compact_readers(flags))
    # the required readers share one participation, the optional ones another; a reader
    # with values of one length needs no tally
    assert spied["runs"] == runs and spied["tally runs"] == tallies
    assert spied["tally"] == 0


@pytest.mark.parametrize("count", [70, 300])
def test_two_byte_codes_recode_in_bulk(count):
    ir, profile, _body = TWO_BYTE_CHAIN
    codec = compile_ir(ir, plan="columnar", profile=profile)
    rows = []
    for i in range(count):
        s0 = ["00", "10", "37", "filler3"][i % 4]
        row = {"s0": s0}
        for j in range(1, 7):
            previous = row[f"s{j - 1}"]
            row[f"s{j}"] = "y" if previous in ("10", "y") else "x" if previous in FILLERS + ["00", "x"] else "z"
        row["n"] = i
        rows.append(row)
    body = codec.encode_body(rows)
    assert codec.decode_body(body) == rows


def _non_uniform_fanout(values):
    ir = _array(*(_field(name, "string") for name in ["s"] + [f"d{i}" for i in range(96)]))
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
        *({"leaf": i + 1, "derived": {"source": 0, "values": values}} for i in range(96)),
    )
    # 100,000 rows alternating 00 and 10: one lane of alternating bits, one constant
    body = "a08d06" + "0300" + "020001" + "aa" * 12500 + "020000" + "0400" * 96
    return ir, profile, body


def test_derived_totals_count_codes_once_per_source(spied):
    limits = Limits(max_total_bytes=9_000_000, max_byte_amplification=2**40)
    # 200,000 bytes of s, then 150,000 per consumer with x and yy, 100,000 with x and y
    for values, rejected in ((["x", "yy"], "d58"), (["x", "y"], "d88")):
        ir, profile, body = _non_uniform_fanout(values)
        codec = compile_ir(ir, plan="columnar", profile=profile, limits=limits)
        with pytest.raises(HyperflyError) as err:
            codec.decode_body(bytes.fromhex(body))
        assert err.value.code == "limit" and f"[].{rejected}[" in str(err.value)
    # x and yy: one tally of s serves every consumer; x and y need none
    assert spied["tally"] == 1



TABLE = {0: 1, 3: 2, 9: 3}


@pytest.mark.parametrize("typecode", ["B", "H", "q", None])
def test_recoding_is_total(typecode):
    values = [0, 10, 3, 9, 300] if typecode != "B" else [0, 10, 3, 9, 255]
    if typecode in ("q", None):
        values.append(-1)
    run = values if typecode is None else array(typecode, values)
    assert list(_codec._recode(run, TABLE)) == [TABLE.get(value, 0) for value in values]


@pytest.mark.parametrize(
    "typecode, values",
    [
        ("B", [i % 13 for i in range(300)]),
        ("B", [250 + i % 6 for i in range(300)]),
        ("H", [256 + i % 13 for i in range(300)]),
        ("H", [256 + i % 13 for i in range(299)] + [3]),
        ("H", [0x3F00 + i % 256 for i in range(300)]),
        # high bytes 0 to 3, which translate under a mask per high byte
        ("H", [(i * 7) % 1024 for i in range(300)]),
        ("H", [255 + i % 2 for i in range(300)]),
    ],
)
@pytest.mark.parametrize("wide", [False, True])
def test_bulk_recoding_matches_lookups(typecode, values, wide, spied):
    straddles = typecode == "H" and max(values) >> 8 != min(values) >> 8
    for keys in (range(0, 0x4000, 3), range(0, 1000, 3)):
        table = {value: (value * 37 + 5) % (1000 if wide else 200) for value in keys}
        recoded = _codec._recode(array(typecode, values), table)
        assert list(recoded) == [table.get(value, 0) for value in values]
        # a table below four high bytes answers in bulk whatever the high bytes
        assert type(recoded) is array or (straddles and len(keys) > 1000 // 3 + 1)
    assert spied["split"] == straddles


def test_lane_codes_are_total():
    keys = {0: 1, 3: 2, 9: 3}
    assert list(_codec._lane_codes([_codec._Values(lambda: array("B", [0, 10]))], 2, keys)) == [1, 0]
    assert list(_codec._lane_codes([_codec._Values(lambda: array("q", [-1, 3]))], 2, keys)) == [0, 2]
    pairs = {(0, 0): 1, (3, 0): 2, (9, 0): 3, (3, 1): 4}
    varying = _codec._Values(lambda: array("q", [-1, 3, 9, 10] * 2))
    for rows in (8, 1):
        assert list(_codec._lane_codes([varying, _codec._constant(0, 8)], rows, pairs)) == [0, 2, 3, 0] * 2


def test_derived_code_lookup_is_total():
    table = (None, "x", "y")
    assert [_codec._derived_code(table, {"x": 5}, code) for code in (0, 1, 2, 3, -1, 0xFFFF)] == [0, 5, 0, 0, 0, 0]


@pytest.mark.parametrize("total, code", [(3000, "ok"), (2999, "limit")])
def test_deferred_derived_totals_are_exact(total, code):
    ir = _array(_field("s", "string"), _field("d", "string"), _field("t", "string"))
    profile = _profile(
        {"leaf": 0, "dict": ["00", "10"], "grammar": [LANE, LANE]},
        {"leaf": 1, "derived": {"source": 0, "values": ["x", "yyy"]}},
    )
    rows = [{"s": "00", "d": "x", "t": "a"} if i % 2 else {"s": "10", "d": "yyy", "t": "a"} for i in range(600)]
    loose = Limits(max_total_bytes=2**40, max_byte_amplification=2**40)
    body = compile_ir(ir, plan="columnar", profile=profile, limits=loose).encode_body(rows)
    # s as a grammar column, its second lane constant, then d derived without escapes
    assert body[2:4] == b"\x03\x00" and b"\x02\x00\x00\x04\x00" in body
    # 1,200 bytes of s, 1,200 of d and 600 of t
    codec = compile_ir(ir, plan="columnar", profile=profile, limits=Limits(max_total_bytes=total, max_byte_amplification=2**40))
    assert _code_of(codec, body) == code


def _code_of(codec, body):
    try:
        codec.decode_body(body)
    except HyperflyError as err:
        return err.code
    return "ok"
