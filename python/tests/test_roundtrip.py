import math
import random

import pytest

from hyperfly import HyperflyError, compile_ir

PRIMS = ["bool", "int", "bounded", "float64", "string", "bytes", "enum", "literal"]


def random_leaf(rng):
    kind = rng.choice(PRIMS)
    if kind == "bounded":
        lo = rng.randint(-1000, 1000)
        return {"kind": "int", "min": lo, "max": lo + rng.randint(0, 100000)}
    if kind == "enum":
        return {"kind": "enum", "members": ["a", "b", "c", "d"][: rng.randint(1, 4)]}
    if kind == "literal":
        return {"kind": "literal", "value": rng.choice(["ok", 7, True, None])}
    return {"kind": kind}


def random_value(rng, node):
    kind = node["kind"]
    if kind == "bool":
        return rng.random() < 0.5
    if kind == "int":
        lo = node.get("min", -(2**53 - 1))
        hi = node.get("max", 2**53 - 1)
        if rng.random() < 0.2:
            return rng.choice([lo, hi])
        return lo + rng.randint(0, min(hi - lo, 2**40))
    if kind == "float64":
        r = rng.random()
        if r < 0.2:
            return 0.0
        if r < 0.6:
            return round(rng.uniform(0, 20000), 2)
        return rng.uniform(-1, 1) * 2 ** rng.randint(-40, 40)
    if kind == "string":
        return rng.choice(["", "héllo", "🚀 launch", "plain", 'q"uote\\'])
    if kind == "bytes":
        return bytes(rng.randint(0, 255) for _ in range(rng.randint(0, 12)))
    if kind == "enum":
        return rng.choice(node["members"])
    if kind == "literal":
        return node["value"]
    raise AssertionError(kind)


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_seeded_roundtrip(plan):
    rng = random.Random(0x48460002)
    for _ in range(200):
        field_count = rng.randint(1, 6)
        fields = []
        for i in range(field_count):
            leaf = random_leaf(rng)
            field = {"name": f"f{i}", "type": leaf}
            if rng.random() < 0.25:
                field["optional"] = True
            nullable_ok = not (leaf["kind"] == "literal" and leaf.get("value") is None)
            if rng.random() < 0.25 and nullable_ok:
                field["nullable"] = True
            fields.append(field)
        ir = {"kind": "array", "element": {"kind": "struct", "fields": fields}}
        codec = compile_ir(ir, plan=plan)

        rows = []
        for _ in range(rng.randint(0, 30)):
            row = {}
            for f in fields:
                if f.get("optional") and rng.random() < 0.3:
                    continue
                if f.get("nullable") and rng.random() < 0.2:
                    row[f["name"]] = None
                else:
                    row[f["name"]] = random_value(rng, f["type"])
            rows.append(row)

        body = codec.encode_body(rows)
        decoded = codec.decode_body(body)
        assert codec.encode_body(decoded) == body
        wire = codec.encode(rows)
        assert codec.encode(codec.decode(wire)) == wire


def test_prose_columns_pack():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "body", "type": {"kind": "string"}}]}}
    rows = [{"body": f"the quick brown fox files report number {i} about the same fox again"} for i in range(40)]
    packed = compile_ir(ir, plan="columnar").encode_body(rows)
    plain = compile_ir(ir, plan="columnar", pack=False).encode_body(rows)
    assert len(packed) < len(plain) * 0.5
    assert compile_ir(ir, plan="columnar").decode_body(packed) == rows


def test_negative_zero_matches_literal_zero():
    codec = compile_ir({"kind": "literal", "value": 0})
    assert codec.encode_body(-0.0) == codec.encode_body(0) == b""
    with pytest.raises(HyperflyError) as err:
        codec.encode_body(1.0)
    assert err.value.code == "type"


def test_integral_float_ir_compiles_to_integers():
    floats = {"kind": "struct", "fields": [
        {"name": "n", "type": {"kind": "int", "min": -0.0, "max": 9.0}},
        {"name": "a", "type": {"kind": "array", "element": {"kind": "literal", "value": -0.0}, "length": 2.0}},
    ]}
    ints = {"kind": "struct", "fields": [
        {"name": "n", "type": {"kind": "int", "min": 0, "max": 9}},
        {"name": "a", "type": {"kind": "array", "element": {"kind": "literal", "value": 0}, "length": 2}},
    ]}
    codec = compile_ir(floats)
    assert codec.ir == ints
    assert type(codec.ir["fields"][1]["type"]["element"]["value"]) is int
    assert codec.fingerprint == compile_ir(ints).fingerprint
    assert codec.decode_body(codec.encode_body({"n": 3, "a": [0, -0.0]})) == {"n": 3, "a": [0, 0]}


def test_float64_negative_zero_is_canonicalized_as_before():
    codec = compile_ir({"kind": "float64"})
    body = codec.encode_body(-0.0)
    assert body == codec.encode_body(0.0) == bytes(8)
    assert math.copysign(1.0, codec.decode_body(body)) == 1.0


def test_integral_float_profile_compiles_to_integers():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
    grammar = [{"lit": "id_"}, {"num": {"base": 16, "len": 4, "case": "lower"}}]
    ints = {"version": 2, "shared": {"columns": [{"leaf": 0, "dict": ["a"], "grammar": grammar}]}}
    floats = {"version": 2.0, "shared": {"columns": [{"leaf": -0.0, "dict": ["a"], "grammar": [
        {"lit": "id_"}, {"num": {"base": 16.0, "len": 4.0, "case": "lower"}},
    ]}]}}
    codec = compile_ir(ir, plan="columnar", profile=floats)
    assert codec.profile == ints
    assert type(codec.profile["shared"]["columns"][0]["leaf"]) is int
    assert codec.fingerprint == compile_ir(ir, plan="columnar", profile=ints).fingerprint
    rows = [{"s": "a"}, {"s": "id_00ff"}]
    assert codec.decode_body(codec.encode_body(rows)) == rows
