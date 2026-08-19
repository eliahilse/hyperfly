"""Regression tests for the codex retro-review findings."""

import zlib

import pytest
from pydantic import BaseModel, ConfigDict, Field, RootModel

from hyperfly import HyperflyError, Limits, compile_ir
from hyperfly._codec import _default_inflate
from hyperfly.pydantic import compile, to_ir


def _packed_body(strings: list[str]) -> bytes:
    concat = b"".join(s.encode() for s in strings)
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    blob = c.compress(concat) + c.flush()
    out = bytearray([1, 1])  # count=1, string mode packed
    # single-string column: length then blob
    from hyperfly._wire import write_uleb

    write_uleb(out, len(strings[0].encode()))
    write_uleb(out, len(blob))
    out += blob
    return bytes(out)


IR_STR_COL = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}


def test_inflate_rejects_zip_bomb_with_zero_total():
    # #1: a blob that expands well past a tiny declared total must not decode
    bomb = zlib.compressobj(6, zlib.DEFLATED, -15)
    blob = bomb.compress(b"A" * 100_000) + bomb.flush()
    with pytest.raises(Exception):
        _default_inflate(blob, 0)


def test_inflate_rejects_truncated_stream():
    # #2: chop the deflate stream; eof check must catch it
    c = zlib.compressobj(6, zlib.DEFLATED, -15)
    full = c.compress(b"hello world") + c.flush()
    with pytest.raises(Exception):
        _default_inflate(full[:-2], len(b"hello world"))


def test_fixed_array_respects_max_items():
    # #3
    ir = {"kind": "array", "element": {"kind": "bool"}, "length": 2}
    codec = compile_ir(ir, limits=Limits(max_items=1))
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes([1, 0]))
    assert err.value.code == "limit"


def test_columnar_depth_enforced():
    # #4
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "int"}}]}}
    codec = compile_ir(ir, plan="columnar", limits=Limits(max_depth=1))
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex("010002"))
    assert err.value.code == "depth"


def test_pydantic_optional_maps_to_nullable():
    # Optional[T] is required-nullable in pydantic; defaults are always materialized,
    # so pydantic does not emit a wire-optional field (documented asymmetry vs zod).
    class M(BaseModel):
        x: str | None = None

    field = to_ir(M)["fields"][0]
    assert field.get("optional") is None and field.get("nullable") is True


def test_pydantic_default_factory_is_encoded_not_dropped():
    import itertools

    counter = itertools.count(100)

    class M(BaseModel):
        seq: int = Field(default_factory=lambda: next(counter))

    codec = compile(M)
    payload = M()
    first = payload.seq
    assert codec.decode(codec.encode(payload)) == {"seq": first}


def test_pydantic_alias_roundtrips_under_validation():
    class M(BaseModel):
        x: int = Field(alias="wire_x")

    codec = compile(M, validate=True)
    m = M(wire_x=7)
    assert codec.decode(codec.encode(m)) == M(wire_x=7)


def test_pydantic_conint_interval_bounds():
    from pydantic import conint

    class M(BaseModel):
        n: conint(gt=1, lt=10)

    assert to_ir(M)["fields"][0]["type"] == {"kind": "int", "min": 2, "max": 9}


def test_pydantic_intersects_int_bounds():
    # #7
    from typing import Annotated

    from annotated_types import Ge, Gt

    class M(BaseModel):
        n: Annotated[int, Ge(10), Gt(0)]

    assert to_ir(M)["fields"][0]["type"] == {"kind": "int", "min": 10}


def test_pydantic_rejects_extra_allow():
    # #9
    class M(BaseModel):
        model_config = ConfigDict(extra="allow")
        x: int

    with pytest.raises(HyperflyError):
        to_ir(M)


def test_pydantic_rejects_root_model():
    # #13
    class M(RootModel[list[int]]):
        pass

    with pytest.raises(HyperflyError):
        to_ir(M)


def test_gt_bound_matches_min_two():
    class M(BaseModel):
        n: int = Field(gt=1)

    assert to_ir(M)["fields"][0]["type"] == {"kind": "int", "min": 2}


def test_extreme_float_falls_back_to_raw_mode():
    import sys

    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "float64"}}]}}
    codec = compile_ir(ir, plan="columnar")
    value = [{"x": sys.float_info.max}, {"x": 1.5}]
    assert codec.decode_body(codec.encode_body(value)) == value


def test_codec_ir_is_isolated_from_mutation():
    codec = compile_ir({"kind": "int", "min": 0})
    codec.ir["min"] = 10
    assert codec.encode_body(0) == b"\x00"


def test_pydantic_rejects_one_sided_alias():
    class M(BaseModel):
        x: int = Field(validation_alias="wire_x")

    with pytest.raises(HyperflyError):
        to_ir(M)
