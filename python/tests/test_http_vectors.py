import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, create_model

import pytest

from conftest import VECTOR_DIR
from hyperfly import CodecRegistry, DecodeError, compile_ir
from hyperfly.http import RequestError, decode_request, decode_response, encode_for, negotiate

VECTOR_PATH = Path(os.environ.get("HYPERFLY_HTTP_VECTORS", VECTOR_DIR / "http.json"))
if not VECTOR_PATH.is_file():
    pytest.skip(f"HTTP vectors not available: {VECTOR_PATH}", allow_module_level=True)
VECTORS = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))


def revive(value):
    if isinstance(value, dict):
        if set(value) == {"$bytes"}:
            return bytes.fromhex(value["$bytes"])
        return {key: revive(item) for key, item in value.items()}
    if isinstance(value, list):
        return [revive(item) for item in value]
    return value


def same_value(actual, expected, ir=None, *, decoded=False):
    while ir is not None and ir["kind"] == "nullable":
        ir = ir["inner"]
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        if decoded and ir:
            kind = ir["kind"]
            if kind == "int" or (kind == "literal" and type(ir["value"]) in (int, float)):
                if type(actual) is not int:
                    return False
            elif kind == "float64":
                if type(actual) is not float:
                    return False
                return actual == float(expected)
        return actual == expected
    if isinstance(actual, dict) and isinstance(expected, dict):
        fields = {field["name"]: field["type"] for field in ir["fields"]} if ir and ir["kind"] == "struct" else None
        keys = actual.keys() if fields is None else actual.keys() & fields.keys()
        expected_keys = expected.keys() if fields is None else expected.keys() & fields.keys()
        return keys == expected_keys and all(
            same_value(actual[key], expected[key], fields[key] if fields is not None else None, decoded=decoded) for key in keys
        )
    if isinstance(actual, list) and isinstance(expected, list):
        element = ir["element"] if ir and ir["kind"] == "array" else None
        return len(actual) == len(expected) and all(same_value(a, b, element, decoded=decoded) for a, b in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


class VectorModel(BaseModel):
    def model_dump(self, **kwargs):
        return super().model_dump(exclude_unset=True, **kwargs)


def declared_type(ir):
    kind = ir["kind"]
    if kind == "struct":
        fields = {}
        for field in ir["fields"]:
            annotation = declared_type(field["type"])
            if field.get("nullable"):
                annotation = annotation | None
            fields[field["name"]] = (annotation, None if field.get("optional") else ...)
        return create_model("VectorValue", __base__=VectorModel, **fields)
    if kind == "array":
        return list[declared_type(ir["element"])]
    if kind == "nullable":
        return declared_type(ir["inner"]) | None
    if kind == "literal":
        return Literal[ir["value"]]
    if kind == "enum":
        return Literal[tuple(ir["members"])]
    return {"bytes": bytes, "bool": bool, "int": int, "float64": float, "string": str}[kind]


def model_input(value, ir):
    """Normalize JSON integral numbers before pydantic validates int literals."""
    kind = ir["kind"]
    if kind == "nullable":
        return None if value is None else model_input(value, ir["inner"])
    if kind == "int" or (kind == "literal" and type(ir["value"]) in (int, float)):
        return int(value) if type(value) is float and value.is_integer() else value
    if kind == "array":
        return [model_input(item, ir["element"]) for item in value]
    if kind == "struct":
        fields = {field["name"]: field["type"] for field in ir["fields"]}
        return {key: model_input(item, fields[key]) if key in fields and item is not None else item
                for key, item in value.items()}
    return value


def test_model_input_normalizes_only_declared_integral_positions():
    ir = {"kind": "struct", "fields": [
        {"name": "integers", "type": {"kind": "array", "element": {"kind": "int"}}},
        {"name": "literal", "type": {"kind": "nullable", "inner": {"kind": "literal", "value": 1}}},
        {"name": "number", "type": {"kind": "float64"}},
    ]}
    original = {"integers": [1.0, 1.5, True], "literal": 1.0, "number": 1.0, "extra": 1.0}
    actual = model_input(original, ir)
    assert actual == original
    assert type(actual["integers"][0]) is int
    assert type(actual["integers"][1]) is float
    assert type(actual["integers"][2]) is bool
    assert type(actual["literal"]) is int
    assert type(actual["number"]) is type(actual["extra"]) is float
    assert type(original["integers"][0]) is type(original["literal"]) is float
    assert model_input({"literal": None}, ir) == {"literal": None}


def decode_json(direction, body, registry):
    if direction == "response":
        return decode_response("application/json", body, registry)
    return decode_request("application/json", None, body, registry)


@pytest.mark.parametrize("direction", ["encode", "response", "request"])
@pytest.mark.parametrize("row", VECTORS["jsonFallback"]["valid"], ids=lambda row: row["name"])
def test_json_fallback_valid(row, direction):
    registry = CodecRegistry([compile_ir(row["ir"])])
    value = revive(row["value"])
    if direction == "encode":
        # A struct's IR bytes positions are represented by declared model fields.
        if row["ir"]["kind"] == "struct":
            value = declared_type(row["ir"]).model_validate(model_input(value, row["ir"]))
        body, headers = encode_for(negotiate(None, registry), value)
        assert headers["Content-Type"] == "application/json"
        assert same_value(json.loads(body), json.loads(row["json"]), row["ir"])
    else:
        kind, actual = decode_json(direction, row["json"].encode("utf-8"), registry)
        assert kind == "json"
        assert same_value(actual, value, row["ir"], decoded=True)


@pytest.mark.parametrize("direction", ["response", "request"])
@pytest.mark.parametrize("row", VECTORS["jsonFallback"]["invalid"], ids=lambda row: row["name"])
def test_json_fallback_invalid(row, direction):
    registry = CodecRegistry([compile_ir(row["ir"])])
    with pytest.raises(DecodeError if direction == "response" else RequestError) as raised:
        decode_json(direction, row["json"].encode("utf-8"), registry)
    if direction == "response":
        assert raised.value.code == row["error"]
    else:
        assert (raised.value.status, raised.value.reason) == (400, "malformed-json")
        assert raised.value.__cause__.code == row["error"]


@pytest.mark.parametrize("row", VECTORS["responses"], ids=lambda row: row["name"])
def test_response_vectors(row):
    registry = CodecRegistry([compile_ir(row["ir"])]) if "ir" in row else CodecRegistry()
    expected = row["expected"]
    if "error" in expected:
        with pytest.raises(DecodeError) as raised:
            decode_response(row["contentType"], bytes.fromhex(row["hex"]), registry)
        assert raised.value.code == expected["error"]
    else:
        kind, value = decode_response(row["contentType"], bytes.fromhex(row["hex"]), registry)
        assert kind == expected["kind"]
        assert same_value(value, revive(expected["value"]), row.get("ir"), decoded=True)


@pytest.mark.parametrize("row", VECTORS["requests"], ids=lambda row: row["name"])
def test_request_vectors(row):
    registry = CodecRegistry([compile_ir(row["ir"])]) if "ir" in row else CodecRegistry()
    options = {"content_length": row.get("contentLength")}
    if "maxBytes" in row:
        options["max_bytes"] = row["maxBytes"]
    expected = row["expected"]
    if "status" in expected:
        with pytest.raises(RequestError) as raised:
            decode_request(row["contentType"], None, bytes.fromhex(row["hex"]), registry, **options)
        assert raised.value.status == expected["status"]
    else:
        kind, value = decode_request(row["contentType"], None, bytes.fromhex(row["hex"]), registry, **options)
        assert kind == expected["kind"]
        assert same_value(value, revive(expected["value"]), row.get("ir"), decoded=True)


@pytest.mark.parametrize("ir,valid,wrong", [
    ({"kind": "int"}, 3, 3.0),
    ({"kind": "literal", "value": 3.0}, 3, 3.0),
    ({"kind": "float64"}, 3.0, 3),
])
def test_decode_comparison_requires_numeric_types_at_every_depth(ir, valid, wrong):
    schema = {"kind": "struct", "fields": [{"name": "rows", "type": {
        "kind": "array", "element": {"kind": "nullable", "inner": ir},
    }}]}
    expected = {"rows": [valid]}
    assert same_value({"rows": [valid]}, expected, schema, decoded=True)
    assert not same_value({"rows": [wrong]}, expected, schema, decoded=True)


@pytest.mark.parametrize("actual,expected,kind,matches", [
    (9007199254740992.0, 9007199254740993, "float64", True),
    (9007199254740992, 9007199254740993, "float64", False),
    (7, 7.0, "int", True),
    (7.0, 7, "int", False),
    (True, 1, "int", False),
])
def test_numeric_vector_comparison_normalizes_binary64(actual, expected, kind, matches):
    assert same_value(actual, expected, {"kind": kind}, decoded=True) is matches
