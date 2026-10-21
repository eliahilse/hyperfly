import math

import pytest

from hyperfly import HyperflyError, compile_ir
from hyperfly import _codec

INT_MAX = 2**53 - 1


def rows_of(type_, values, **flags):
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "v", "type": type_, **flags}]}}
    return ir, [{"v": v} for v in values]


@pytest.mark.parametrize("method", ["encode", "encode_body"])
@pytest.mark.parametrize("node, value", [
    ({"kind": "int"}, 1),
    ({"kind": "int"}, -7),
    ({"kind": "int"}, 0),
    ({"kind": "int"}, INT_MAX),
    ({"kind": "int"}, -INT_MAX),
    ({"kind": "int", "min": -5, "max": 5}, 5),
    ({"kind": "int", "min": 10}, 12),
    ({"kind": "nullable", "inner": {"kind": "int"}}, 3),
    ({"kind": "array", "element": {"kind": "int"}}, [1, 2, 3]),
    ({"kind": "literal", "value": 1}, 1),
    ({"kind": "literal", "value": -INT_MAX}, -INT_MAX),
])
def test_integral_floats_encode_as_the_equal_int(method, node, value):
    codec = compile_ir(node)
    as_float = [float(v) for v in value] if isinstance(value, list) else float(value)
    body = getattr(codec, method)(as_float)
    assert body == getattr(codec, method)(value)
    decoded = codec.decode(body) if method == "encode" else codec.decode_body(body)
    assert decoded == value
    assert all(type(v) is int for v in (decoded if isinstance(decoded, list) else [decoded]) if v is not None)


def test_proposed_vector_rows():
    assert compile_ir({"kind": "int"}).encode_body(1.0).hex() == "02"
    assert compile_ir({"kind": "literal", "value": 1}).encode_body(1.0).hex() == ""


def test_negative_zero_encodes_as_zero():
    codec = compile_ir({"kind": "int"})
    assert codec.encode_body(-0.0) == codec.encode_body(0) == b"\x00"
    assert compile_ir({"kind": "int", "min": 0}).encode_body(-0.0) == b"\x00"


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("node", [{"kind": "int"}, {"kind": "literal", "value": 1}])
@pytest.mark.parametrize("value", [1.5, -0.5, math.nan, math.inf, -math.inf, 2.0**53, -(2.0**53), 1e300, True, False, "1"])
def test_other_values_stay_type_errors(plan, node, value):
    ir, rows = rows_of(node, [value])
    for codec, body in ((compile_ir(node, plan=plan), value), (compile_ir(ir, plan=plan), rows)):
        with pytest.raises(HyperflyError) as err:
            codec.encode_body(body)
        assert err.value.code == "type"


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("value", [6.0, -6.0])
def test_integral_floats_outside_declared_bounds_are_range_errors(plan, value):
    ir, rows = rows_of({"kind": "int", "min": -5, "max": 5}, [value])
    with pytest.raises(HyperflyError) as err:
        compile_ir(ir, plan=plan).encode_body(rows)
    assert err.value.code == "range"
    assert f"v{'' if plan == 'row' else '[0]'}: {int(value)} " in str(err.value)


UNBOUNDED = {"kind": "int"}
BOUNDED = {"kind": "int", "min": 0}
# raw, delta, frame of reference, delta frame of reference, patched frame of reference
COLUMNS = [
    (UNBOUNDED, [3, -9, 120, -77, 5], 0x00),
    (BOUNDED, [5], 0x00),
    (UNBOUNDED, [10**12, 10**12 + 1], 0x01),
    (BOUNDED, [10**12, 10**12 + 1], 0x01),
    (UNBOUNDED, [1000 + (i * 37) % 64 for i in range(40)], 0x02),
    (BOUNDED, [1000 + (i * 37) % 64 for i in range(40)], 0x02),
    (UNBOUNDED, [10**9 + 1000 * i + (i * 7) % 3 for i in range(40)], 0x03),
    (BOUNDED, [10**9 + 1000 * i + (i * 7) % 3 for i in range(40)], 0x03),
    (UNBOUNDED, [(i * 13) % 8 for i in range(60)] + [10**6], 0x04),
    (BOUNDED, [(i * 13) % 8 for i in range(60)] + [10**6], 0x04),
]


@pytest.mark.parametrize("node, values, mode", COLUMNS)
def test_columnar_int_modes_accept_integral_floats(node, values, mode):
    ir, rows = rows_of(node, values)
    codec = compile_ir(ir, plan="columnar")
    body = codec.encode_body(rows)
    assert body[1] == mode
    assert codec.encode_body([{"v": float(row["v"])} for row in rows]) == body
    assert codec.decode_body(body) == rows


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_nullable_and_optional_int_fields_accept_integral_floats(plan):
    ir, rows = rows_of({"kind": "int"}, [1, None, 3], optional=True, nullable=True)
    rows.append({})
    codec = compile_ir(ir, plan=plan)
    floats = [{"v": float(row["v"])} if row.get("v") is not None else row for row in rows]
    assert codec.encode_body(floats) == codec.encode_body(rows)
    ir, rows = rows_of({"kind": "nullable", "inner": {"kind": "int"}}, [2, None])
    codec = compile_ir(ir, plan=plan)
    assert codec.encode_body([{"v": 2.0}, {"v": None}]) == codec.encode_body(rows)


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_int_literal_columns_accept_integral_floats(plan):
    ir, rows = rows_of({"kind": "literal", "value": 7}, [7, 7])
    codec = compile_ir(ir, plan=plan)
    assert codec.encode_body([{"v": 7.0}, {"v": 7}]) == codec.encode_body(rows)
    with pytest.raises(HyperflyError) as err:
        codec.encode_body([{"v": 7.5}])
    assert err.value.code == "type"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_ints_never_take_the_float_path(plan, monkeypatch):
    ir, rows = rows_of({"kind": "int"}, [(i * 7919) % 100003 - 50000 for i in range(1000)])
    codec = compile_ir(ir, plan=plan)
    expected = codec.encode_body(rows)

    def refuse(v, path):
        raise AssertionError("an int took the float path")

    monkeypatch.setattr(_codec, "_integral_float", refuse)
    assert codec.encode_body(rows) == expected
