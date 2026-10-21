"""Traversal and error precedence at the boundaries of compiled row readers."""

import struct

import pytest

from hyperfly import DecodeError, Limits, compile_ir


def failure(codec, body, code, message):
    with pytest.raises(DecodeError) as error:
        codec.decode_body(body)
    assert error.value.code == code
    assert str(error.value) == message


def test_struct_checks_both_bitmap_padding_before_values():
    fields = [dict(name=f"f{i}", type={"kind": "bool"}, optional=True, nullable=True) for i in range(9)]
    codec = compile_ir({"kind": "struct", "fields": fields})
    # The first boolean is invalid too; neither value is visited before padding.
    failure(codec, b"\xff\x01\x00\x02\x02", "bitmap", "$: nonzero bitmap padding")
    failure(codec, b"\xff\x02", "bitmap", "$: nonzero bitmap padding")
    failure(codec, b"\xff\x01\x00", "truncated", "unexpected end of input")


def test_absent_null_bit_fails_at_its_field_in_declared_order():
    codec = compile_ir({"kind": "struct", "fields": [
        dict(name="first", type={"kind": "bool"}),
        dict(name="absent", type={"kind": "bool"}, optional=True, nullable=True),
    ]})
    failure(codec, b"\x00\x01\x02", "marker", "$.first: invalid bool byte 0x2")
    failure(codec, b"\x00\x01\x01", "bitmap", "$.absent: null bit set for absent field")


def test_unvisited_deep_field_does_not_fail_at_compile_or_decode():
    codec = compile_ir({"kind": "struct", "fields": [
        dict(name="maybe", type={"kind": "nullable", "inner": {"kind": "bool"}}, optional=True),
    ]}, limits=Limits(max_depth=0))
    assert codec.decode_body(b"\x00") == {}
    failure(codec, b"\x01\x00", "depth", "$.maybe: nesting deeper than 0")


@pytest.mark.parametrize("value,message", [
    (-0.0, "negative-zero bit pattern"), (float("inf"), "non-finite float64"),
    (float("nan"), "non-finite float64"),
])
def test_float_failure_precedes_later_truncation(value, message):
    codec = compile_ir({"kind": "array", "element": {"kind": "float64"}})
    failure(codec, b"\x02" + struct.pack("<d", value), "float", f"$[0]: {message}")


def test_length_budget_precedes_bytes_and_utf8():
    codec = compile_ir({"kind": "array", "element": {"kind": "string"}},
                       limits=Limits(max_total_bytes=1))
    failure(codec, b"\x02\x01a\x02\xff", "limit", "$[1]: 3 bytes exceed the byte budget of 1")
