"""Regression tests for the codex retro-review findings."""

import zlib

import pytest
from pydantic import BaseModel, ConfigDict, Field, RootModel

from hyperfly import HyperflyError, Limits, compile_ir
from hyperfly._codec import _default_inflate, _match_grammar
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


def test_declared_count_bounded_by_remaining_input():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "int"}}]}}
    bomb = bytes([0x80, 0x80, 0x80, 0x08])  # declares 2**24 rows, carries no payload
    for plan in ("row", "columnar"):
        with pytest.raises(HyperflyError) as err:
            compile_ir(ir, plan=plan).decode_body(bomb)
        assert err.value.code == "limit"


def test_encoder_respects_its_own_limits():
    codec = compile_ir({"kind": "string"}, limits=Limits(max_byte_length=1))
    with pytest.raises(HyperflyError) as err:
        codec.encode_body("ab")
    assert err.value.code == "limit"


def test_deflate_without_inflate_does_not_pack():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    rows = [{"s": "aaaaaaaaaaaaaaaaaaaaaaaa"} for _ in range(20)]
    import zlib

    def deflate(data: bytes) -> bytes:
        c = zlib.compressobj(6, zlib.DEFLATED, -15)
        return c.compress(data) + c.flush()

    codec = compile_ir(ir, plan="columnar", pack={"deflate": deflate})
    assert codec.decode_body(codec.encode_body(rows)) == rows


def test_deflate_candidate_above_total_byte_limit_is_not_emitted():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    codec = compile_ir(
        ir,
        plan="columnar",
        limits=Limits(max_byte_length=3),
        pack={"deflate": lambda _data: b"", "inflate": lambda _data, _size: b""},
    )
    body = codec.encode_body([{"s": "aa"}, {"s": "bb"}])
    assert body[1] == 0x00
    assert codec.decode_body(body) == [{"s": "aa"}, {"s": "bb"}]


def test_aliased_array_nodes_get_distinct_ordinals():
    # A golden vector cannot express this: IR loaded from JSON always has distinct
    # objects, so only an in-memory schema reusing one node reaches the hazard.
    arr = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    ir = {"kind": "struct", "fields": [{"name": "a", "type": arr}, {"name": "b", "type": arr}]}
    profile = {
        "version": 1,
        "shared": {"columns": [
            {"leaf": 0, "dict": ["red", "green"]},
            {"leaf": 1, "dict": ["green", "red"]},
        ]},
    }
    codec = compile_ir(ir, plan="columnar", profile=profile, pack=False)
    value = {"a": [{"s": "red"}], "b": [{"s": "red"}]}
    assert codec.encode_body(value).hex() == "0101010101010202"
    assert codec.decode_body(codec.encode_body(value)) == value


def test_codec_profile_is_isolated_from_mutation():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    profile = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["online", "offline"]}]}}
    codec = compile_ir(ir, plan="columnar", profile=profile, pack=False)
    body = codec.encode_body([{"s": "online"}])
    codec.profile["shared"]["columns"][0]["dict"][0] = "HIJACKED"
    profile["shared"]["columns"][0]["dict"][0] = "HIJACKED"
    assert codec.decode_body(body) == [{"s": "online"}]


def test_columnar_amplification_limit_is_configurable_on_encode_and_decode():
    ir = {
        "kind": "array",
        "element": {
            "kind": "struct",
            "fields": [{"name": "e", "type": {"kind": "enum", "members": ["only"]}}],
        },
    }
    rows = [{"e": "only"}, {"e": "only"}]
    strict = compile_ir(ir, plan="columnar", limits=Limits(max_amplification=1), pack=False)
    with pytest.raises(HyperflyError) as encoded:
        strict.encode_body(rows)
    assert encoded.value.code == "limit"
    with pytest.raises(HyperflyError) as decoded:
        strict.decode_body(b"\x02")
    assert decoded.value.code == "limit"

    exact = compile_ir(ir, plan="columnar", limits=Limits(max_amplification=2), pack=False)
    assert exact.encode_body(rows) == b"\x02"
    assert exact.decode_body(b"\x02") == rows


def test_zero_payload_row_array_uses_amplification_limit():
    ir = {"kind": "array", "element": {"kind": "literal", "value": 0}}
    rows = [0] * 5
    strict = compile_ir(ir, limits=Limits(max_amplification=4))
    with pytest.raises(HyperflyError) as encoded:
        strict.encode_body(rows)
    assert encoded.value.code == "limit"
    with pytest.raises(HyperflyError) as decoded:
        strict.decode_body(b"\x05")
    assert decoded.value.code == "limit"


def test_profile_reconstructions_respect_max_byte_length():
    ir = {
        "kind": "array",
        "element": {
            "kind": "struct",
            "fields": [{"name": "s", "type": {"kind": "string"}}],
        },
    }
    cases = [
        (
            {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["a-value-well-beyond-eight-bytes"]}]}},
            [{"s": "a-value-well-beyond-eight-bytes"}],
        ),
        (
            {
                "version": 2,
                "shared": {
                    "columns": [
                        {
                            "leaf": 0,
                            "grammar": [
                                {"lit": "quite-a-long-prefix-"},
                                {"num": {"base": 10, "len": 2, "case": "lower"}},
                            ],
                        }
                    ]
                },
            },
            [{"s": "quite-a-long-prefix-07"}],
        ),
    ]
    for profile, value in cases:
        lax = compile_ir(ir, plan="columnar", profile=profile, pack=False)
        body = lax.encode_body(value)
        tight = compile_ir(
            ir,
            plan="columnar",
            profile=profile,
            pack=False,
            limits=Limits(max_byte_length=8),
        )
        with pytest.raises(HyperflyError) as err:
            tight.decode_body(body)
        assert err.value.code == "limit"


def test_derived_reconstruction_respects_max_byte_length():
    ir = {
        "kind": "array",
        "element": {
            "kind": "struct",
            "fields": [
                {"name": "source", "type": {"kind": "string"}},
                {"name": "target", "type": {"kind": "string"}},
            ],
        },
    }
    target = "a-derived-value-well-beyond-eight-bytes"
    profile = {
        "version": 2,
        "shared": {
            "columns": [
                {"leaf": 0, "dict": ["u1"]},
                {"leaf": 1, "derived": {"source": 0, "values": [target]}},
            ]
        },
    }
    value = [{"source": "u1", "target": target}]
    lax = compile_ir(ir, plan="columnar", profile=profile, pack=False)
    body = lax.encode_body(value)
    tight = compile_ir(
        ir,
        plan="columnar",
        profile=profile,
        pack=False,
        limits=Limits(max_byte_length=8),
    )
    with pytest.raises(HyperflyError) as err:
        tight.decode_body(body)
    assert err.value.code == "limit"


def test_grammar_matching_uses_only_the_exact_ascii_alphabet():
    lower_hex = [{"num": {"base": 16, "len": 2, "case": "lower"}}]
    assert _match_grammar("af", lower_hex) == [175]
    for value in ("AF", "+1", "1_", " 1", "１2", "1٢"):
        assert _match_grammar(value, lower_hex) is None


def test_deflate_hook_never_sees_a_disqualified_aggregate():
    """A column whose concatenation exceeds max_byte_length is not a deflate
    candidate, so the hook must not be invoked with it at all (PR gate)."""
    calls = []

    def counting_deflate(data: bytes) -> bytes:
        calls.append(len(data))
        return b""

    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    codec = compile_ir(
        ir,
        plan="columnar",
        limits=Limits(max_byte_length=3),
        pack={"deflate": counting_deflate, "inflate": lambda _data, _size: b""},
    )
    value = [{"s": "aa"}, {"s": "aa"}]
    body = codec.encode_body(value)
    assert codec.decode_body(body) == value
    assert body[1] == 0x00
    assert calls == []
