import random

import pytest

from hyperfly import compile_ir

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
