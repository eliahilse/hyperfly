import json
import sys
import tracemalloc

import pytest
from conftest import calls

from hyperfly import CodecRegistry, DecodeError, HyperflyError, compile_ir
from hyperfly.http import RequestError, decode_request, decode_response, read_body


def decode(direction, body, registry):
    if direction == "response":
        return decode_response("application/json", body, registry)
    return decode_request("application/json", None, body, registry)


@pytest.mark.parametrize("direction", ["response", "request"])
@pytest.mark.parametrize("ir,body,expected", [
    ({"kind": "bool"}, "true", True),
    ({"kind": "bool"}, "false", False),
    *[({"kind": "int"}, token, 3) for token in ("3", "3.0", "3e0")],
    ({"kind": "int"}, "-0.0", 0),
    ({"kind": "int"}, "9007199254740991", 2**53 - 1),
    ({"kind": "int"}, "-9007199254740991", -(2**53 - 1)),
    ({"kind": "int", "min": 1, "max": 3}, "1.0", 1),
    ({"kind": "int", "min": 1, "max": 3}, "3e0", 3),
    ({"kind": "int", "min": -3, "max": 3}, "-3.0", -3),
    ({"kind": "float64"}, "3", 3.0),
    ({"kind": "float64"}, "1e20", 1e20),
    ({"kind": "float64"}, "0.1", 0.1),
    ({"kind": "float64"}, "-0.0", -0.0),
    ({"kind": "string"}, '"héllo"', "héllo"),
    ({"kind": "enum", "members": ["a", "b"]}, '"b"', "b"),
    *[({"kind": "literal", "value": 3}, token, 3) for token in ("3", "3.0", "3e0")],
    ({"kind": "literal", "value": 3.0}, "3e0", 3),
    ({"kind": "literal", "value": True}, "true", True),
    ({"kind": "literal", "value": False}, "false", False),
    ({"kind": "literal", "value": "a"}, '"a"', "a"),
    ({"kind": "literal", "value": None}, "null", None),
    ({"kind": "bytes"}, '"AAE="', b"\x00\x01"),
    ({"kind": "nullable", "inner": {"kind": "int"}}, "null", None),
    ({"kind": "nullable", "inner": {"kind": "int"}}, "3.0", 3),
    ({"kind": "array", "element": {"kind": "int"}}, "[3.0,3e0]", [3, 3]),
    ({"kind": "array", "element": {"kind": "bool"}, "length": 0}, "[]", []),
    ({"kind": "array", "element": {"kind": "bool"}, "length": 1}, "[true]", [True]),
    ({"kind": "struct", "fields": []}, '{"unknown":[null,"AB=="]}', {}),
])
def test_json_converts_each_node_to_its_codec_value(direction, ir, body, expected):
    kind, actual = decode(direction, body.encode(), CodecRegistry([compile_ir(ir)]))
    assert kind == "json"
    assert actual == expected
    assert type(actual) is type(expected)
    if isinstance(actual, list):
        assert all(type(a) is type(b) for a, b in zip(actual, expected))


@pytest.mark.parametrize("direction", ["response", "request"])
@pytest.mark.parametrize("ir,tokens,reason", [
    ({"kind": "bool"}, ["0", '"true"', "null", "[]", "{}"], "expected boolean"),
    ({"kind": "int"}, ["true", '"3"', "null", "[]", "{}", "1.5", "1e400", "-1e400",
                       "9007199254740992", "-9007199254740992", "1" * 5000], "expected integral number"),
    ({"kind": "int", "min": 1}, ["0.0"], "outside declared bounds"),
    ({"kind": "int", "max": 3}, ["4e0"], "outside declared bounds"),
    ({"kind": "float64"}, ["true", '"3"', "null", "[]", "{}"], "expected number"),
    ({"kind": "float64"}, ["1e400", "-1e400", "1" * 400], "expected finite float64"),
    ({"kind": "string"}, ["1", "false", "null", "[]", "{}"], "expected string"),
    ({"kind": "enum", "members": ["a"]}, ["1", "true", "null"], "expected string"),
    ({"kind": "enum", "members": ["a"]}, ['"b"'], "unknown enum member"),
    ({"kind": "literal", "value": 1}, ["true", '"1"', "1.5", "null", "1e400"], "expected integral number"),
    ({"kind": "literal", "value": 1}, ["2.0"], "literal mismatch"),
    ({"kind": "literal", "value": True}, ["1", "false", "null"], "literal mismatch"),
    ({"kind": "literal", "value": False}, ["0", "true", "null"], "literal mismatch"),
    ({"kind": "literal", "value": "a"}, ['"b"', "true", "null"], "literal mismatch"),
    ({"kind": "literal", "value": None}, ["0", '"null"', "false"], "literal mismatch"),
    ({"kind": "bytes"}, ["0", "false", "null", "[]", "{}"], "expected a base64 string"),
    ({"kind": "bytes"}, ['"AB=="', '"AAEC="'], "expected canonical padded base64"),
    ({"kind": "nullable", "inner": {"kind": "int"}}, ['"3"'], "expected integral number"),
    ({"kind": "array", "element": {"kind": "int"}}, ["0", '"3"', "null", "{}"], "expected array"),
    ({"kind": "array", "element": {"kind": "int"}, "length": 1}, ["[]", "[1,2]"], "declared length"),
    ({"kind": "struct", "fields": []}, ["0", '"3"', "null", "[]"], "expected object"),
])
def test_json_conversion_failures_report_nested_paths(direction, ir, tokens, reason):
    root = {"kind": "struct", "fields": [{"name": "rows", "type": {
        "kind": "array", "element": {"kind": "struct", "fields": [{"name": "value", "type": ir}]},
    }}]}
    registry = CodecRegistry([compile_ir(root)])
    for token in tokens:
        body = ('{"rows":[{"value":' + token + '}]}').encode()
        with pytest.raises(DecodeError if direction == "response" else RequestError) as raised:
            decode(direction, body, registry)
        error = raised.value
        if direction == "request":
            assert (error.status, error.reason, error.headers) == (400, "malformed-json", {})
            error = error.__cause__
        assert isinstance(error, DecodeError) and error.code == "json"
        assert str(error).startswith("$.rows[0].value:")
        assert reason in str(error)


@pytest.mark.parametrize("direction", ["response", "request"])
def test_json_struct_field_flags_and_unknown_keys(direction):
    ir = {"kind": "struct", "fields": [
        {"name": "required", "type": {"kind": "int"}},
        {"name": "optional", "type": {"kind": "bytes"}, "optional": True},
        {"name": "nullable", "type": {"kind": "bool"}, "nullable": True},
        {"name": "both", "type": {"kind": "bool"}, "nullable": True, "optional": True},
    ]}
    registry = CodecRegistry([compile_ir(ir)])
    for value, expected in [
        ({"required": 3.0, "nullable": None, "ignored": {"required": None}}, {"required": 3, "nullable": None}),
        ({"required": 3.0, "nullable": True, "optional": "AA==", "both": None},
         {"required": 3, "nullable": True, "optional": b"\0", "both": None}),
        ({"required": 3.0, "nullable": False, "both": True}, {"required": 3, "nullable": False, "both": True}),
    ]:
        kind, actual = decode(direction, json.dumps(value).encode(), registry)
        assert (kind, actual) == ("json", expected)
        assert type(actual["required"]) is int
    for body, path, reason in [
        (b'{"nullable":null}', "$.required", "missing required field"),
        (b'{"required":3}', "$.nullable", "missing required field"),
        (b'{"required":null,"nullable":null}', "$.required", "expected integral number"),
        (b'{"required":3,"nullable":null,"optional":null}', "$.optional", "expected a base64 string"),
        (b'{"required":3,"nullable":null,"both":1}', "$.both", "expected boolean"),
    ]:
        with pytest.raises(DecodeError if direction == "response" else RequestError) as raised:
            decode(direction, body, registry)
        error = raised.value if direction == "response" else raised.value.__cause__
        assert error.code == "json"
        assert f"{path}: {reason}" in str(error)


def test_json_conversion_supports_the_deepest_ir():
    # the artifact is depth 1 and the IR depth 2, so 510 arrays nest the artifact 512 deep
    ir = {"kind": "int"}
    for _ in range(510):
        ir = {"kind": "array", "element": ir}
    with pytest.raises(HyperflyError) as raised:
        compile_ir({"kind": "array", "element": ir})
    assert (raised.value.code, str(raised.value)) == ("ir", "artifact nests deeper than 512")
    registry = CodecRegistry([compile_ir(ir)])
    for direction in ("response", "request"):
        kind, value = decode(direction, b"[" * 510 + b"3e0" + b"]" * 510, registry)
        assert kind == "json"
        for _ in range(510):
            assert isinstance(value, list) and len(value) == 1
            value = value[0]
        assert type(value) is int and value == 3


def test_json_conversion_work_scales_linearly_with_rows():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [
        {"name": "id", "type": {"kind": "int"}},
        {"name": "data", "type": {"kind": "bytes"}},
    ]}}
    registry = CodecRegistry([compile_ir(ir)])
    body = json.dumps([{"id": 3.0, "data": "AA=="}] * 1000).encode()
    doubled = json.dumps([{"id": 3.0, "data": "AA=="}] * 2000).encode()
    small = calls(lambda: decode_response("application/json", body, registry))
    large = calls(lambda: decode_response("application/json", doubled, registry))
    assert 2 * small - 100 <= large <= 2 * small + 100


@pytest.mark.parametrize("length", ["2", " \t2\t ", "0" * 5000 + "2", "9" * 5000])
def test_content_length_rejects_before_acquiring_body_iterator(length):
    class Unread:
        def __iter__(self):
            raise AssertionError("body must not be read")

    for read in (
        lambda: read_body(Unread(), max_bytes=1, content_length=length),
        lambda: decode_request("application/json", None, Unread(), CodecRegistry(), max_bytes=1, content_length=length),
    ):
        with pytest.raises(RequestError) as raised:
            read()
        assert (raised.value.status, raised.value.reason) == (413, "too-large")


@pytest.mark.parametrize("direction", ["response", "request"])
@pytest.mark.parametrize("depth,count", [(490, 50_000), (0, 200_000)])
def test_json_array_conversion_memory_is_bounded_by_depth(direction, depth, count):
    ir = {"kind": "int"}
    for _ in range(max(1, depth)):
        ir = {"kind": "array", "element": ir}
    recursion_limit = sys.getrecursionlimit()
    try:
        sys.setrecursionlimit(max(recursion_limit, 3000))
        registry = CodecRegistry([compile_ir(ir)])
    finally:
        sys.setrecursionlimit(recursion_limit)
    layers = max(1, depth)
    body = b"[" * layers + b",".join([b"0"] * count) + b"]" * layers
    if depth:
        assert len(body) == 100_979
    tracemalloc.start()
    try:
        kind, value = decode(direction, body, registry)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Includes JSON parsing and its output; queuing every child exceeds this bound.
    assert peak < 6 << 20
    assert kind == "json"
    for _ in range(layers - 1):
        value = value[0]
    assert len(value) == count and all(type(item) is int and item == 0 for item in value)


@pytest.mark.parametrize("direction", ["response", "request"])
def test_json_conversion_uses_first_registered_schema(direction):
    def schema(kind, name):
        return {"kind": "struct", "fields": [{"name": "rows", "type": {
            "kind": "array", "element": {"kind": "struct", "fields": [
                {"name": name, "type": {"kind": kind}},
            ]},
        }}]}
    integer = compile_ir(schema("int", "integer"))
    number = compile_ir(schema("float64", "number"))
    body = b'{"rows":[{"integer":3.0,"number":3}]}'
    for codecs, name, expected_type in [([integer, number], "integer", int), ([number, integer], "number", float)]:
        kind, value = decode(direction, body, CodecRegistry(codecs))
        assert (kind, value) == ("json", {"rows": [{name: 3}]})
        assert type(value["rows"][0][name]) is expected_type


@pytest.mark.parametrize("direction", ["response", "request"])
def test_json_enum_members_are_indexed_once_per_node(direction):
    class Members(list):
        iterations = 0

        def __iter__(self):
            self.iterations += 1
            return super().__iter__()

        def __contains__(self, item):
            raise AssertionError("enum membership must use a set")

    codec = compile_ir({"kind": "array", "element": {"kind": "enum", "members": [f"v{i}" for i in range(2000)]}})
    members = Members(codec._ir["element"]["members"])
    codec._ir["element"]["members"] = members
    registry = CodecRegistry([codec])
    body = json.dumps(["v1999"] * 8000).encode()
    for _ in range(2):
        assert decode(direction, body, registry) == ("json", ["v1999"] * 8000)
    assert members.iterations == 2
    assert codec._ir["element"]["members"] is members
