import tracemalloc
from array import array

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
# under a small profile: the memory ratio allowed (two-byte codes hold twice the bytes
# of one-byte codes), and whether both have the same columns
COST_PAIRS = [
    ("dictionary size", _derived_table(16383), _derived_table(2), 1.5, True),
    ("grammar domain", _lane_table(4), _lane_table(1), 1.5, True),
    ("derived fan-out", _derived_fanout(6), _derived_fanout(1), 1.5, False),
    ("two-byte codes", TWO_BYTE_CHAIN, ONE_BYTE_CHAIN, 2.5, True),
    ("two-byte codes across a high byte", STRADDLING_CHAIN, _chain(98, "aa"), 2.5, True),
    ("non-uniform derived values", _nested_derived(["x"] * 254 + ["yy"]), _nested_derived(["x"] * 255), 1.5, True),
]


def _peak(run):
    tracemalloc.start()
    try:
        run()
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def _rejects(codec, body, code="marker"):
    def run():
        with pytest.raises(HyperflyError) as err:
            codec.decode_body(body)
        assert err.value.code == code

    return run


@pytest.mark.parametrize(
    "large, small, memory, same_shape", [case[1:] for case in COST_PAIRS], ids=[case[0] for case in COST_PAIRS]
)
def test_cost_follows_the_body_not_the_profile(large, small, memory, same_shape):
    # memory and calls against the same body under a small profile, in one process, so
    # neither the runner nor the interpreter version moves the bound
    peaks = []
    counts = []
    for ir, profile, body in (large, small):
        run = _rejects(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body))
        run()
        peaks.append(_peak(run))
        counts.append(calls(run))
    assert peaks[0] < memory * peaks[1] + (1 << 20)
    if same_shape:
        assert counts[0] < 1.25 * counts[1] + 8192


@pytest.fixture
def spied(monkeypatch):
    """Counts of the helpers whose work could follow a profile's domain: every table
    _recode is handed with the rows it serves and whether it answered per row, source
    tallies, masked translates, and grammar code lookups."""
    seen = {"recode": [], "tally": 0, "split": 0, "grammar codes": 0}

    def wrap(name, record):
        original = getattr(_codec, name, None)
        if original is None:
            return

        def spy(*args, **kwargs):
            result = original(*args, **kwargs)
            record(args, result)
            return result

        monkeypatch.setattr(_codec, name, spy)

    def recode(args, result):
        values, table = args
        rows = len(values) if hasattr(values, "__len__") else None
        seen["recode"].append((len(table), rows, type(result) is array))

    wrap("_recode", recode)
    wrap("_tally", lambda args, result: seen.__setitem__("tally", seen["tally"] + 1))
    wrap("_translate_split", lambda args, result: seen.__setitem__("split", seen["split"] + 1))
    grammar_codes = _codec._Ctx.grammar_codes

    def counted(self, *args):
        seen["grammar codes"] += 1
        return grammar_codes(self, *args)

    monkeypatch.setattr(_codec._Ctx, "grammar_codes", counted)
    return seen


@pytest.mark.parametrize(
    "case", [case[1] for case in COST_PAIRS[:2]] + [TWO_BYTE_CHAIN, STRADDLING_CHAIN], ids=[case[0] for case in COST_PAIRS[:2]] + ["two-byte codes", "two-byte codes across a high byte"]
)
def test_lookups_follow_the_rows(case, spied):
    ir, profile, body = case
    _rejects(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body))()
    for size, rows, bulk in spied["recode"]:
        # no table larger than the rows it serves, and no long run answered row by row
        assert rows is None or size <= max(4 * rows, 256)
        assert rows is None or rows < 256 or bulk
    if case is STRADDLING_CHAIN:
        # the five derived columns another derives from, each over codes 255 and 256
        assert spied["split"] == 5


def test_derived_columns_read_their_source_once(spied):
    ir, profile, body = _derived_fanout(6)
    _rejects(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body))()
    assert spied["grammar codes"] == 1


def test_short_derived_columns_take_no_tally(spied):
    ir, profile, body = _nested_derived(["x"] * 254 + ["yy"])
    _rejects(compile_ir(ir, plan="columnar", profile=profile), bytes.fromhex(body))()
    assert spied["tally"] == 0


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
