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


@pytest.mark.parametrize("bad_index", [0, 15, 63])
def test_uniform_length_column_keeps_utf8_and_budget_order(bad_index):
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [
        dict(name="s", type={"kind": "string"}),
    ]}}
    codec = compile_ir(ir, plan="columnar", limits=Limits(max_total_bytes=63))
    body = bytearray(b"\x40\x00" + b"\x01a" * 64)
    body[3 + 2 * bad_index] = 0xFF
    code = "limit" if bad_index == 63 else "utf8"
    with pytest.raises(DecodeError) as error:
        codec.decode_body(body)
    assert error.value.code == code
    assert str(error.value).startswith(f"$[].s[{bad_index}]:")


def test_two_byte_varint_batches_preserve_values_and_first_error():
    from hyperfly._wire import Reader, read_ulebs, write_uleb

    values = [128, 255, 256, 16383] * 32
    body = bytearray()
    for value in values:
        write_uleb(body, value)
    reader = Reader(bytes(body), Limits())
    decoded, error = read_ulebs(reader, len(values))
    assert list(decoded) == values
    assert error is None
    assert reader.remaining() == 0
    for index in (0, 63, 127):
        malformed = body.copy()
        malformed[2 * index + 1] = 0
        decoded, error = read_ulebs(Reader(bytes(malformed), Limits()), len(values))
        assert list(decoded) == values[:index]
        assert error.code == "varint"


@pytest.mark.parametrize("kind,empty", [("string", ""), ("bytes", b"")])
@pytest.mark.parametrize("flagged", [False, True])
@pytest.mark.parametrize("count", [16, 17, 64])
def test_uniform_empty_column_preserves_every_row(kind, empty, flagged, count):
    field = dict(name="value", type={"kind": kind})
    if flagged:
        field.update(optional=True, nullable=True)
    codec = compile_ir({"kind": "array", "element": {"kind": "struct", "fields": [field]}},
                       plan="columnar", pack=False)
    rows = [{"value": empty} for _ in range(count)]
    if flagged:
        rows[2] = {"value": None}
        rows[7] = {}
    body = codec.encode_body(rows)
    assert codec.decode_body(body) == rows
