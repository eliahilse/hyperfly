import pytest

from hyperfly import HyperflyError, compile_ir


def _struct(**fields):
    return {"kind": "struct", "fields": [{"name": name, "type": t} for name, t in fields.items()]}


def _fixed(length, element):
    return {"kind": "array", "length": length, "element": element}


def _rows(element):
    return {"kind": "array", "element": element}


INT = {"kind": "int"}
EMPTY_INTS = _fixed(0, _struct(a=INT))


def _decode_error(codec, body):
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(body))
    return err.value.code


def test_empty_fixed_columnar_arrays_carry_their_mode_bytes():
    codec = compile_ir(_rows(EMPTY_INTS), plan="columnar")
    assert codec.encode_body([[], []]).hex() == "020000"
    assert codec.decode_body(bytes.fromhex("020000")) == [[], []]
    assert _decode_error(codec, "0200") == "truncated"
    assert _decode_error(codec, "02000000") == "trailing"


def test_empty_fixed_row_arrays_occupy_nothing():
    codec = compile_ir(_rows(EMPTY_INTS), plan="row")
    assert codec.encode_body([[], []]).hex() == "02"
    assert codec.decode_body(b"\x02") == [[], []]
    assert _decode_error(codec, "0200") == "trailing"


# plan-columnar-v5 §3: with k = 0, int, float64 and string columns still write a 0x00
# mode byte and every other column nothing; bitmaps over 0 rows are 0 bytes
LEAVES = [
    ("int", {"a": INT}, "00"),
    ("float64", {"a": {"kind": "float64"}}, "00"),
    ("string", {"a": {"kind": "string"}}, "00"),
    ("bool", {"a": {"kind": "bool"}}, ""),
    ("bytes", {"a": {"kind": "bytes"}}, ""),
    ("enum", {"a": {"kind": "enum", "members": ["x", "y"]}}, ""),
    ("literal", {"a": {"kind": "literal", "value": 1}}, ""),
    ("nullable node", {"a": {"kind": "nullable", "inner": INT}}, ""),
    ("int, bool, string", {"a": INT, "b": {"kind": "bool"}, "c": {"kind": "string"}}, "0000"),
    ("nested struct", {"s": _struct(a=INT, b={"kind": "float64"})}, "0000"),
]


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("fields, headers", [case[1:] for case in LEAVES], ids=[case[0] for case in LEAVES])
def test_empty_fixed_arrays_of_each_leaf(fields, headers, plan):
    codec = compile_ir(_rows(_fixed(0, _struct(**fields))), plan=plan)
    per_row = headers if plan == "columnar" else ""
    body = "03" + per_row * 3
    assert codec.encode_body([[], [], []]).hex() == body
    assert codec.decode_body(bytes.fromhex(body)) == [[], [], []]
    assert _decode_error(codec, body + "00") == "trailing"
    if per_row:
        assert _decode_error(codec, body[:-2]) == "truncated"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_flag_leaves_keep_their_mode_byte_at_zero_rows(plan):
    element = {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": INT, "nullable": True},
            {"name": "b", "type": {"kind": "string"}, "optional": True},
        ],
    }
    codec = compile_ir(_rows(_fixed(0, element)), plan=plan)
    body = "02" + ("0000" * 2 if plan == "columnar" else "")
    assert codec.encode_body([[], []]).hex() == body
    assert codec.decode_body(bytes.fromhex(body)) == [[], []]


NESTED = [
    # the middle array's element is an array, so it is row-encoded and holds nothing
    ("0 of 0", _fixed(0, EMPTY_INTS), [], "02", "02"),
    ("2 of 0", _fixed(2, EMPTY_INTS), [[], []], "02", "02" + "0000" * 2),
    ("1 of 1 of 0", _fixed(1, _fixed(1, _fixed(0, _struct(s={"kind": "string"})))), [[[]]], "02", "02" + "00" * 2),
    ("struct field", _struct(x=_fixed(0, _struct(s={"kind": "string"}))), {"x": []}, "02", "02" + "00" * 2),
]


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("element, item, row, columnar", [case[1:] for case in NESTED], ids=[case[0] for case in NESTED])
def test_nested_empty_fixed_arrays(element, item, row, columnar, plan):
    codec = compile_ir(_rows(element), plan=plan)
    body = row if plan == "row" else columnar
    assert codec.encode_body([item, item]).hex() == body
    decoded = codec.decode_body(bytes.fromhex(body))
    assert decoded == [item, item]
    assert decoded[0] is not decoded[1]
    assert _decode_error(codec, body + "00") == "trailing"
    if len(body) > 2:
        assert _decode_error(codec, body[:-2]) == "truncated"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_zero_bit_elements_still_decode_from_nothing(plan):
    element = _fixed(2, _struct(t={"kind": "literal", "value": 7}))
    codec = compile_ir(_rows(element), plan=plan)
    value = [[{"t": 7}, {"t": 7}] for _ in range(20)]
    assert codec.encode_body(value).hex() == "14"
    decoded = codec.decode_body(b"\x14")
    assert decoded == value
    decoded[0][0]["t"] = 8
    assert decoded[1][0]["t"] == 7


@pytest.mark.parametrize("kind", ["int", "float64", "string"])
@pytest.mark.parametrize("body", ["0201", "0202", "0204", "020100", "0200ff"])
def test_empty_fixed_columnar_arrays_reject_a_nonzero_mode_byte(kind, body):
    codec = compile_ir(_rows(_fixed(0, _struct(a={"kind": kind}))), plan="columnar")
    assert _decode_error(codec, body) == "marker"


def _profile(*columns):
    return {"version": 2, "shared": {"columns": list(columns)}}


PROFILED = [
    ("dictionary", {"a": {"kind": "string"}}, _profile({"leaf": 0, "dict": ["x", "y"]}), "00", ["0201", "020001"]),
    (
        "derived from a dictionary",
        {"a": {"kind": "string"}, "c": {"kind": "string"}},
        _profile({"leaf": 0, "dict": ["x"]}, {"leaf": 1, "derived": {"source": 0, "values": ["y"]}}),
        "0000",
        ["0201000000", "0200010000", "0200040000"],
    ),
]


@pytest.mark.parametrize("fields, profile, headers, invalid", [case[1:] for case in PROFILED], ids=[case[0] for case in PROFILED])
def test_profiled_empty_fixed_arrays(fields, profile, headers, invalid):
    codec = compile_ir(_rows(_fixed(0, _struct(**fields))), plan="columnar", profile=profile, pack=False)
    body = "02" + headers * 2
    assert codec.encode_body([[], []]).hex() == body
    assert codec.decode_body(bytes.fromhex(body)) == [[], []]
    assert _decode_error(codec, body[:-2]) == "truncated"
    for bad in invalid:
        assert _decode_error(codec, bad) == "marker"
