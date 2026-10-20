import pytest

from conftest import load
from hyperfly import HyperflyError, compile_ir

VECTORS = load("vectors.json")
COLUMNAR = load("columnar.json")
IR = load("ir.json")


def deep_eq(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is bool and type(b) is bool and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(deep_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(deep_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def run_valid(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    value = revive(vector["value"])
    assert codec.encode_body(value).hex() == vector["hex"], vector["name"]
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), value), vector["name"]


def run_invalid_decode(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    with pytest.raises(HyperflyError) as err:
        codec.decode_body(bytes.fromhex(vector["hex"]))
    assert err.value.code == vector["error"], vector["name"]


def revive(value):
    """A copy with surrogate and bytes markers revived, without recursion: before Python 3.12 the
    512-deep IR rows would exceed the recursion limit."""
    holder = [value]
    stack = [(holder, 0)]
    while stack:
        parent, key = stack.pop()
        item = parent[key]
        if isinstance(item, dict) and "$surrogate" in item:
            parent[key] = chr(int(item["$surrogate"], 16))
        elif isinstance(item, dict) and set(item) == {"$bytes"}:
            parent[key] = bytes.fromhex(item["$bytes"])
        elif isinstance(item, dict):
            parent[key] = copy = dict(item)
            stack.extend((copy, inner) for inner in copy)
        elif isinstance(item, list):
            parent[key] = copy = list(item)
            stack.extend((copy, index) for index in range(len(copy)))
    return holder[0]


def run_invalid_encode(vector, plan):
    codec = compile_ir(vector["ir"], plan=plan)
    with pytest.raises(HyperflyError) as err:
        codec.encode_body(revive(vector["value"]))
    assert err.value.code == vector["error"], vector["name"]


def compile_vector(vector, plan):
    if "profile" in vector:
        return compile_ir(revive(vector["ir"]), plan="columnar", profile=revive(vector["profile"]), pack=False)
    return compile_ir(revive(vector["ir"]), plan=plan)


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("vector", IR["invalid"], ids=lambda v: v["name"])
def test_ir_invalid(vector, plan):
    with pytest.raises(HyperflyError) as err:
        compile_vector(vector, plan)
    assert err.value.code == vector["error"], vector["name"]


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("vector", IR["valid"], ids=lambda v: v["name"])
def test_ir_valid(vector, plan):
    compile_vector(vector, plan)


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
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), revive(vector["value"]))


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
    value = revive(vector["value"])
    assert codec.encode_body(value).hex() == vector["hex"], vector["name"]
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), value), vector["name"]


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


@pytest.mark.parametrize("vector", PROFILED["decodeOnly"], ids=lambda v: v["name"])
def test_profiled_decode_only(vector):
    codec = compile_ir(vector["ir"], plan="columnar", profile=vector["profile"], pack=False)
    assert deep_eq(codec.decode_body(bytes.fromhex(vector["hex"])), revive(vector["value"])), vector["name"]


@pytest.mark.parametrize("vector", PROFILED["invalidProfile"], ids=lambda v: v["name"])
def test_profiled_invalid_profile(vector):
    with pytest.raises(HyperflyError) as err:
        compile_ir(
            vector["ir"],
            plan="columnar",
            profile=revive(vector["profile"]),
            pack=False,
        )
    assert err.value.code == vector["error"], vector["name"]
