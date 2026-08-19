import pytest

from conftest import load
from hyperfly import HyperflyError, compile_ir

VECTORS = load("vectors.json")
COLUMNAR = load("columnar.json")


def deep_eq(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is bool and type(b) is bool and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(deep_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(deep_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def run_valid(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    assert codec.encode_body(vector["value"]).hex() == vector["hex"], vector["name"]
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), vector["value"]), vector["name"]


def run_invalid_decode(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"], vector["name"]


def revive(value):
    if isinstance(value, dict) and "$surrogate" in value:
        return chr(int(value["$surrogate"], 16))
    return value


def run_invalid_encode(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    with pytest.raises(HyperflyError) as err:
        codec.encode_body(revive(vector["value"]))
    assert err.value.code == vector["error"], vector["name"]


@pytest.mark.parametrize("vector", VECTORS["valid"], ids=lambda v: v["name"])
def test_row_valid(vector):
    run_valid(vector, "row")


@pytest.mark.parametrize("vector", VECTORS["invalidDecode"], ids=lambda v: v["name"])
def test_row_invalid_decode(vector):
    run_invalid_decode(vector, "row")


@pytest.mark.parametrize("vector", VECTORS["invalidEncode"], ids=lambda v: v["name"])
def test_row_invalid_encode(vector):
    run_invalid_encode(vector, "row")


@pytest.mark.parametrize("vector", COLUMNAR["valid"], ids=lambda v: v["name"])
def test_columnar_valid(vector):
    run_valid(vector, "columnar")


@pytest.mark.parametrize("vector", COLUMNAR["invalidDecode"], ids=lambda v: v["name"])
def test_columnar_invalid_decode(vector):
    run_invalid_decode(vector, "columnar")


@pytest.mark.parametrize("vector", COLUMNAR["invalidEncode"], ids=lambda v: v["name"])
def test_columnar_invalid_encode(vector):
    run_invalid_encode(vector, "columnar")


@pytest.mark.parametrize("vector", COLUMNAR["packedDecode"], ids=lambda v: v["name"])
def test_columnar_packed_decode(vector):
    codec = compile_ir(vector["ir"], plan="columnar")
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), vector["value"])


def test_packed_without_inflate_fails_closed():
    vector = COLUMNAR["packedDecode"][0]
    codec = compile_ir(vector["ir"], plan="columnar", pack=False)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == "unsupported"


PROFILED = COLUMNAR["profiled"]


@pytest.mark.parametrize("vector", PROFILED["valid"], ids=lambda v: v["name"])
def test_profiled_valid(vector):
    codec = compile_ir(vector["ir"], plan="columnar", profile=vector["profile"], pack=False)
    assert codec.encode_body(vector["value"]).hex() == vector["hex"], vector["name"]
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), vector["value"]), vector["name"]


@pytest.mark.parametrize("vector", PROFILED["invalidDecode"], ids=lambda v: v["name"])
def test_profiled_invalid_decode(vector):
    codec = compile_ir(vector["ir"], plan="columnar", profile=vector["profile"], pack=False)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"], vector["name"]


@pytest.mark.parametrize("vector", PROFILED["requiresProfile"], ids=lambda v: v["name"])
def test_profiled_requires_profile(vector):
    codec = compile_ir(vector["ir"], plan="columnar", pack=False)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"], vector["name"]
