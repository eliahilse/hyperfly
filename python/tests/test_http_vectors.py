import json
import os
from pathlib import Path

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


def same_value(actual, expected):
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return float(actual) == float(expected)
    if isinstance(actual, dict) and isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(same_value(actual[key], expected[key]) for key in actual)
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(same_value(a, b) for a, b in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


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
        body, headers = encode_for(negotiate(None, registry), value)
        assert headers["Content-Type"] == "application/json"
        assert same_value(json.loads(body), json.loads(row["json"]))
    else:
        kind, actual = decode_json(direction, row["json"].encode("utf-8"), registry)
        assert kind == "json"
        assert same_value(actual, value)


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
    with pytest.raises(DecodeError) as raised:
        decode_response(row["contentType"], bytes.fromhex(row["hex"]), registry)
    assert raised.value.code == row["error"]


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
        assert same_value(value, revive(expected["value"]))
