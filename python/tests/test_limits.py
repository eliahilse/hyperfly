import dataclasses
import tracemalloc

import pytest

from conftest import load
from hyperfly import HyperflyError, Limits, compile_ir
from test_vectors import deep_eq

LIMITS = load("limits.json")

FIELDS = {
    "maxDepth": "max_depth",
    "maxItems": "max_items",
    "maxByteLength": "max_byte_length",
    "maxAmplification": "max_amplification",
    "maxTotalItems": "max_total_items",
}


def codec_for(vector):
    overrides = {FIELDS[key]: value for key, value in vector.get("limits", {}).items()}
    limits = dataclasses.replace(Limits(), **overrides)
    return compile_ir(vector["ir"], plan=vector["plan"], limits=limits)


def revive(value):
    if isinstance(value, dict) and set(value) == {"$bytes"}:
        return bytes.fromhex(value["$bytes"])
    if isinstance(value, dict):
        return {key: revive(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [revive(inner) for inner in value]
    return value


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
