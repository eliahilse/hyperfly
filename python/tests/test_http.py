import json
import math
import sys
import time
import tracemalloc
import warnings
from enum import Enum, IntEnum

import pytest
from conftest import load
from pydantic import BaseModel

from hyperfly import HEADER_SIZE, WIRE_VERSION, CodecRegistry, DecodeError, EncodeError, HyperflyError, Limits, compile_ir
from hyperfly.http import (
    DEFAULT_MAX_BODY_BYTES,
    HYPERFLY_MEDIA_TYPE,
    DecodedRequest,
    RequestError,
    accept_header,
    decode_request,
    decode_response,
    encode_for,
    negotiate,
    parse_accept,
    read_body,
    serve_artifact,
)
from hyperfly.pydantic import compile as compile_model

IR = {"kind": "struct", "fields": [{"name": "id", "type": {"kind": "string"}}]}
IR_B = {"kind": "struct", "fields": [{"name": "id", "type": {"kind": "string"}}, {"name": "n", "type": {"kind": "int"}}]}
CODEC_A = compile_ir(IR)
CODEC_B = compile_ir(IR_B)
VALUE = {"id": "abc"}

FINGERPRINT_A = "a" * 32
FINGERPRINT_B = "b" * 32
FINGERPRINTS = [format(i, "032x") for i in range(32)]
ACCEPT_CASES = [
    (None, []),
    ("", []),
    (FINGERPRINT_A, [FINGERPRINT_A]),
    (f"{FINGERPRINT_B}, {FINGERPRINT_A}", [FINGERPRINT_B, FINGERPRINT_A]),
    (f" \t{FINGERPRINT_A}\t ,\t {FINGERPRINT_B} \t", [FINGERPRINT_A, FINGERPRINT_B]),
    *[(f"{space}{FINGERPRINT_A}", []) for space in ("\n", "\r", "\v", "\f", "\u00a0", "\u2003")],
    *[(f"{FINGERPRINT_A}{space}", []) for space in ("\n", "\r", "\v", "\f", "\u00a0", "\u2003")],
    (FINGERPRINT_A.upper(), []),
    ("a" * 31, []),
    ("a" * 33, []),
    ("g" * 32, []),
    (",,,", []),
    ("," * 31 + FINGERPRINT_A, [FINGERPRINT_A]),
    ("," * 32 + FINGERPRINT_A, []),
    (f"{FINGERPRINT_A},{FINGERPRINT_B},{FINGERPRINT_A}", [FINGERPRINT_A, FINGERPRINT_B]),
    (",".join([FINGERPRINT_A] * 31 + [FINGERPRINT_B]), [FINGERPRINT_A, FINGERPRINT_B]),
    (",".join([FINGERPRINT_A] * 32 + [FINGERPRINT_B]), [FINGERPRINT_A]),
    (", ".join(FINGERPRINTS), FINGERPRINTS),
    ("nope," * 32 + FINGERPRINT_A, []),
    ("," * (1024 * 1024), []),
    (FINGERPRINT_A + ",", [FINGERPRINT_A]),
    ("," * 31 + FINGERPRINT_A + ",", [FINGERPRINT_A]),
    (",".join(FINGERPRINTS[1:] + ["f" * 32, FINGERPRINT_A]), FINGERPRINTS[1:] + ["f" * 32]),
    ("," * 31 + FINGERPRINT_A + "," + FINGERPRINT_B, [FINGERPRINT_A]),
    (FINGERPRINT_A + "\n," + FINGERPRINT_B, [FINGERPRINT_B]),
    (" " + FINGERPRINT_A + "\t, " + FINGERPRINT_A, [FINGERPRINT_A]),
    ("a" * 16 + " " + "a" * 15, []),
    ("aB" * 16, []),
    (("x" * 4096 + ",") * 32 + FINGERPRINT_A, []),
]


def _assert_accept_rows(rows):
    for row in rows:
        assert parse_accept(row["header"]) == row["expected"]


@pytest.mark.parametrize("header,expected", ACCEPT_CASES)
def test_parse_accept(header, expected):
    _assert_accept_rows([{"header": header, "expected": expected}])


@pytest.mark.parametrize("row", load("accept.json"), ids=lambda row: row["name"])
def test_parse_accept_vectors(row):
    _assert_accept_rows([row])


def test_parse_accept_bounds_allocation_by_examined_segments():
    tracemalloc.start()
    try:
        for header, expected in [
            ("x" * (1 << 20) + "," + FINGERPRINT_A, [FINGERPRINT_A]),
            (" " * (1 << 20) + FINGERPRINT_A, [FINGERPRINT_A]),
            ("x" * (1 << 20), []),
        ]:
            tracemalloc.reset_peak()
            before = tracemalloc.get_traced_memory()[0]
            assert parse_accept(header) == expected
            assert tracemalloc.get_traced_memory()[1] - before < 64 * 1024
    finally:
        tracemalloc.stop()


def test_parse_accept_stops_after_the_cap():
    class Header(str):
        def find(self, sub, start=0, end=None):
            assert start < 32, "segment past the cap examined"
            return str.find(self, sub, start)

    assert parse_accept(Header("," * 32 + "x" * (1 << 20))) == []


def test_accept_header_emits_only_valid_lowercase_fingerprints():
    assert accept_header([]) == ""
    assert accept_header([
        FINGERPRINT_B, FINGERPRINT_A.upper(), "nope", "a" * 31, "a" * 33,
        "g" * 32, f" {FINGERPRINT_A}", f"{FINGERPRINT_A}\n", FINGERPRINT_A,
    ]) == f"{FINGERPRINT_B}, {FINGERPRINT_A}"


def test_binary_when_the_client_holds_the_codec():
    registry = CodecRegistry([CODEC_A])
    decision = negotiate(accept_header([CODEC_A.fingerprint]), registry)
    assert decision.kind == "hyperfly"
    assert decision.headers["Content-Type"] == HYPERFLY_MEDIA_TYPE
    assert decision.headers["Hyperfly-Codec"] == CODEC_A.fingerprint


def test_json_fallback_offers_an_upgrade():
    registry = CodecRegistry([CODEC_A])
    decision = negotiate(accept_header(["f" * 32]), registry)
    assert decision.kind == "json"
    assert decision.headers["Hyperfly-Offer"] == CODEC_A.fingerprint


@pytest.mark.parametrize("offer,expected", [(None, CODEC_A.fingerprint), ("", None), (CODEC_B.fingerprint, CODEC_B.fingerprint)])
@pytest.mark.parametrize("http_accept", [None, "application/vnd.hyperfly;q=0"])
def test_json_fallback_offer_can_be_defaulted_or_suppressed(offer, expected, http_accept):
    decision = negotiate(None, CodecRegistry([CODEC_A, CODEC_B]), offer=offer, http_accept=http_accept)
    assert decision.kind == "json"
    assert decision.headers.get("Hyperfly-Offer") == expected
    assert ("Hyperfly-Offer" in decision.headers) == (expected is not None)


def test_every_response_varies_so_caches_cannot_cross_serve():
    registry = CodecRegistry([CODEC_A])
    for accept in (accept_header([CODEC_A.fingerprint]), None):
        assert negotiate(accept, registry).headers["Vary"] == "Hyperfly-Accept, Accept"


def test_operator_switch_falls_back_without_consulting_the_registry():
    registry = CodecRegistry([CODEC_A])
    assert negotiate(accept_header([CODEC_A.fingerprint]), registry, enabled=False).kind == "json"


def test_client_preference_decides():
    registry = CodecRegistry([CODEC_A, CODEC_B])
    first = negotiate(accept_header([CODEC_B.fingerprint, CODEC_A.fingerprint]), registry)
    second = negotiate(accept_header([CODEC_A.fingerprint, CODEC_B.fingerprint]), registry)
    assert first.headers["Hyperfly-Codec"] == CODEC_B.fingerprint
    assert second.headers["Hyperfly-Codec"] == CODEC_A.fingerprint


@pytest.mark.parametrize("accept", [None, "x"])
def test_json_round_trip(accept):
    registry = CodecRegistry([CODEC_A])
    body, headers = encode_for(negotiate(accept, registry), VALUE)
    assert decode_response(headers["Content-Type"], body, registry) == ("json", VALUE)


def test_binary_round_trip():
    registry = CodecRegistry([CODEC_A])
    body, headers = encode_for(negotiate(accept_header([CODEC_A.fingerprint]), registry), VALUE)
    assert decode_response(headers["Content-Type"], body, registry) == ("hyperfly", VALUE)


def test_a_client_without_the_codec_reports_a_miss():
    registry = CodecRegistry([CODEC_A])
    body, headers = encode_for(negotiate(accept_header([CODEC_A.fingerprint]), registry), VALUE)
    kind, fingerprint = decode_response(headers["Content-Type"], body, CodecRegistry())
    assert kind == "unknown-codec"
    assert fingerprint == CODEC_A.fingerprint


def test_artifact_discovery():
    registry = CodecRegistry([CODEC_A])
    hit = serve_artifact(f"/.well-known/hyperfly/{CODEC_A.fingerprint}", registry)
    assert hit.status == 200
    assert hit.body == CODEC_A.artifact
    assert "immutable" in hit.headers["Cache-Control"]
    assert serve_artifact(f"/.well-known/hyperfly/{'f' * 32}", registry).status == 404
    assert serve_artifact("/.well-known/hyperfly/nope", registry).status == 404
    assert serve_artifact("/v1/events", registry) is None


def test_a_client_can_bootstrap_from_a_served_artifact():
    import json

    registry = CodecRegistry([CODEC_A])
    served = serve_artifact(f"/.well-known/hyperfly/{CODEC_A.fingerprint}", registry)
    parsed = json.loads(served.body)
    rebuilt = compile_ir(parsed["ir"], plan=parsed["plan"]["layout"])
    assert rebuilt.fingerprint == CODEC_A.fingerprint
    assert rebuilt.decode(CODEC_A.encode(VALUE)) == VALUE


def test_rotation_keeps_every_client_served():
    registry = CodecRegistry([CODEC_A])
    old_client = accept_header([CODEC_A.fingerprint])
    new_client = accept_header([CODEC_B.fingerprint, CODEC_A.fingerprint])

    assert negotiate(new_client, registry).kind == "hyperfly"
    registry.add(CODEC_B)
    assert negotiate(new_client, registry).headers["Hyperfly-Codec"] == CODEC_B.fingerprint
    assert negotiate(old_client, registry).headers["Hyperfly-Codec"] == CODEC_A.fingerprint

    registry.remove(CODEC_A.fingerprint)
    assert negotiate(new_client, registry).headers["Hyperfly-Codec"] == CODEC_B.fingerprint
    assert negotiate(old_client, registry).kind == "json"


def test_json_fallback_serializes_models_in_json_mode():
    class State(Enum):
        online = "online"

    class Response(BaseModel):
        state: State
        message: str

    value = Response(state=State.online, message="héllo 🚀")
    body, headers = encode_for(negotiate(None, CodecRegistry()), value)
    assert body == '{"state":"online","message":"héllo 🚀"}'.encode("utf-8")
    assert headers["Content-Type"] == "application/json"


def test_json_fallback_preserves_model_json_types_alongside_bytes():
    from datetime import datetime, timezone
    from decimal import Decimal

    class Response(BaseModel):
        time: datetime
        amount: Decimal
        payload: bytes

    value = Response(time=datetime(2026, 1, 1, tzinfo=timezone.utc), amount=Decimal("1.25"), payload=b"\xff")
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"time": "2026-01-01T00:00:00Z", "amount": "1.25", "payload": "/w=="}


@pytest.mark.parametrize("with_bytes", [False, True])
def test_json_fallback_preserves_json_only_field_serializer(with_bytes):
    from datetime import datetime
    from pydantic import field_serializer

    class Response(BaseModel):
        t: datetime

        @field_serializer("t", when_used="json")
        def serialize_time(self, value):
            return "T"

    class BinaryResponse(Response):
        payload: bytes

    value = BinaryResponse(t=datetime(2026, 1, 1), payload=b"hi") if with_bytes else Response(t=datetime(2026, 1, 1))
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == ({"t": "T", "payload": "aGk="} if with_bytes else {"t": "T"})


@pytest.mark.parametrize("payload", [b"hi", b"\xfb\xff\xfe\x00"])
def test_json_fallback_nested_json_serializers_preserved_with_non_utf8_bytes(payload):
    import base64
    from pydantic import ConfigDict, field_serializer

    class Child(BaseModel):
        model_config = ConfigDict(title="nested", ser_json_bytes="utf8")
        payload: bytes
        number: int

        @field_serializer("number", when_used="json")
        def serialize_number(self, value):
            return f"number:{value}"

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes="utf8")
        child: Child

    value = Response(child=Child(payload=payload, number=7))
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"child": {"payload": base64.b64encode(payload).decode(), "number": "number:7"}}
    assert Child.model_config["ser_json_bytes"] == "utf8"
    assert Response.model_config["ser_json_bytes"] == "utf8"
    if payload != b"hi":
        with pytest.raises(UnicodeDecodeError):
            value.child.model_dump(mode="json")


def test_json_fallback_preserves_json_only_plain_serializer():
    from typing import Annotated
    from pydantic import PlainSerializer

    class Response(BaseModel):
        number: Annotated[int, PlainSerializer(lambda value: f"number:{value}", when_used="json")]
        payload: bytes

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(number=7, payload=b"hi"))
    assert json.loads(body) == {"number": "number:7", "payload": "aGk="}


def test_json_fallback_preserves_model_serializer_divergent_shapes():
    from pydantic import model_serializer

    class Response(BaseModel):
        payload: bytes
        items: list[bytes]

        @model_serializer(mode="wrap")
        def serialize(self, handler, info):
            if info.mode == "json":
                return {"message": "custom", "items": "collapsed"}
            return handler(self)

    value = Response(payload=b"hi", items=[b"hi"])
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"message": "custom", "items": "collapsed"}


def test_json_fallback_preserves_bytes_serializer_divergent_shape():
    from pydantic import field_serializer

    class Response(BaseModel):
        payload: bytes

        @field_serializer("payload", when_used="json")
        def serialize_payload(self, value):
            return {"size": len(value)}

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(payload=b"hi"))
    assert Response(payload=b"hi").model_dump(mode="json") == {"payload": {"size": 2}}
    assert json.loads(body) == {"payload": {"size": 2}}


def test_json_fallback_preserves_model_json_config():
    from datetime import timedelta
    from pydantic import ConfigDict

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_timedelta="float")
        duration: timedelta
        payload: bytes

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(duration=timedelta(seconds=90), payload=b"hi"))
    assert json.loads(body) == {"duration": 90.0, "payload": "aGk="}


@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("optional", [None, b"optional"])
def test_json_fallback_overlays_model_bytes_positions(bytes_mode, optional):
    from pydantic import ConfigDict, Field

    class Child(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes = Field(alias="data")

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes = Field(alias="data")
        child: Child
        items: list[bytes]
        optional: bytes | None

    value = Response(data=b"hi", child=Child(data=b"hi"), items=[b"hi"], optional=optional)
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {
        "data": "aGk=", "child": {"data": "aGk="}, "items": ["aGk="],
        "optional": "b3B0aW9uYWw=" if optional else None,
    }


@pytest.mark.parametrize("construction", ["construct", "assign"])
@pytest.mark.parametrize("annotation", [bytes, list[bytes], list[list[bytes]]])
@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("payload", ["already text", 7, None, ["text", 7, None], [["text", 7, None]], [b"test"]])
def test_json_fallback_unvalidated_bytes_positions_follow_json_mode(construction, annotation, bytes_mode, payload):
    from pydantic import ConfigDict, Field

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode, validate_assignment=False)
        payload: annotation = Field(serialization_alias="data")

    data = payload if annotation is bytes else [payload] if annotation == list[bytes] else [[payload]]
    if construction == "construct":
        value = Response.model_construct(payload=data)
    else:
        value = Response.model_construct()
        value.payload = data

    with warnings.catch_warnings(record=True) as expected_warnings:
        warnings.simplefilter("always")
        expected = value.model_dump(mode="json", by_alias=True)
    with warnings.catch_warnings(record=True) as actual_warnings:
        warnings.simplefilter("always")
        body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == expected
    assert [(item.category, str(item.message)) for item in actual_warnings] == [
        (item.category, str(item.message)) for item in expected_warnings
    ]


@pytest.mark.parametrize("construction", ["construct", "assign"])
@pytest.mark.parametrize("annotation", [bytes, list[bytes], list[list[bytes]]])
@pytest.mark.parametrize("payload", [object(), [b"\xff"]])
def test_json_fallback_unvalidated_bytes_positions_preserve_failures(construction, annotation, payload):
    class Response(BaseModel):
        payload: annotation

    data = payload if annotation is bytes else [payload] if annotation == list[bytes] else [[payload]]
    value = Response.model_construct(**({"payload": data} if construction == "construct" else {}))
    if construction == "assign":
        value.payload = data

    with warnings.catch_warnings(record=True) as expected_warnings:
        warnings.simplefilter("always")
        with pytest.raises(Exception) as original:
            value.model_dump(mode="json", by_alias=True)
    with warnings.catch_warnings(record=True) as actual_warnings:
        warnings.simplefilter("always")
        with pytest.raises(EncodeError) as raised:
            encode_for(negotiate(None, CodecRegistry()), value)
    assert raised.value.code == "json"
    assert str(original.value) in str(raised.value)
    assert [(item.category, str(item.message)) for item in actual_warnings] == [
        (item.category, str(item.message)) for item in expected_warnings
    ]


@pytest.mark.parametrize("payload", [b"\xfb\xff", bytearray(b"\xfb\xff")])
@pytest.mark.parametrize("annotation", [bytes, list[bytes], list[list[bytes]]])
def test_json_fallback_unvalidated_binary_bytes_positions_use_base64(annotation, payload):
    class Response(BaseModel):
        payload: annotation

    data = payload if annotation is bytes else [payload] if annotation == list[bytes] else [[payload]]
    expected = "+/8=" if annotation is bytes else ["+/8="] if annotation == list[bytes] else [["+/8="]]
    value = Response.model_construct(payload=data)
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {"payload": expected}


@pytest.mark.parametrize("construction", ["construct", "assign"])
@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("position", ["model", "nullable", "list-item", "tuple-item", "root-model"])
@pytest.mark.parametrize("payload", [
    "dict", "bytes-dict", "binary-dict", "none", "wrong-model", "binary-model", "other-model", "str", "list", "tuple",
])
def test_json_fallback_unvalidated_model_subtrees_follow_json_mode(construction, bytes_mode, position, payload):
    from pydantic import ConfigDict, Field, RootModel

    class Child(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes

    class Wrong(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes

    class Other(BaseModel):
        message: str = "other fields"

    annotation = {
        "model": Child, "nullable": Child | None, "list-item": list[Child],
        "tuple-item": tuple[Child, ...], "root-model": RootModel[bytes],
    }[position]

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode, validate_assignment=False)
        child: annotation = Field(serialization_alias="data")
        sibling: bytes = b"test"

    data = {
        "dict": {"payload": "already text"}, "bytes-dict": {"payload": b"test"},
        "binary-dict": {"payload": b"\xff"}, "none": None, "wrong-model": Wrong(payload=b"test"),
        "binary-model": Wrong(payload=b"\xff"),
        "other-model": Other(), "str": "already text", "list": [{"payload": b"test"}],
        "tuple": ({"payload": b"test"},),
    }[payload]
    if position == "list-item":
        data = [data]
    elif position == "tuple-item":
        data = (data,)
    value = Response.model_construct(**({"child": data} if construction == "construct" else {}))
    if construction == "assign":
        value.child = data

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            expected = value.model_dump(mode="json", by_alias=True)
        except Exception as original:
            with pytest.raises(EncodeError) as raised:
                encode_for(negotiate(None, CodecRegistry()), value)
            assert raised.value.code == "json"
            assert str(original) in str(raised.value)
        else:
            expected["sibling"] = "dGVzdA=="
            body, _ = encode_for(negotiate(None, CodecRegistry()), value)
            assert json.loads(body) == expected


@pytest.mark.parametrize("construction", ["construct", "assign"])
@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("position", ["list", "tuple", "fixed-tuple", "nested-list", "list-model", "tuple-model"])
@pytest.mark.parametrize("payload", ["dict", "none", "wrong-model", "str", "wrong-sequence"])
def test_json_fallback_unvalidated_sequence_subtrees_follow_json_mode(construction, bytes_mode, position, payload):
    from pydantic import ConfigDict, Field

    class Child(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes

    annotation = {
        "list": list[bytes], "tuple": tuple[bytes, ...], "fixed-tuple": tuple[bytes],
        "nested-list": list[list[bytes]], "list-model": list[Child], "tuple-model": tuple[Child, ...],
    }[position]

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode, validate_assignment=False)
        child: annotation = Field(serialization_alias="data")
        sibling: bytes = b"test"

    item = Child(payload=b"test") if position.endswith("model") else b"test"
    data = {
        "dict": {"payload": b"test"}, "none": None, "wrong-model": Child(payload=b"test"),
        "str": "already text", "wrong-sequence": [item] if "tuple" in position else (item,),
    }[payload]
    if position == "nested-list":
        data = [data]
    value = Response.model_construct(**({"child": data} if construction == "construct" else {}))
    if construction == "assign":
        value.child = data

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        expected = value.model_dump(mode="json", by_alias=True)
        expected["sibling"] = "dGVzdA=="
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("payload", ["already text", {"payload": "already text"}, None])
def test_json_fallback_unvalidated_fixed_tuple_extra_items_keep_json_mode(payload):
    class Response(BaseModel):
        children: tuple[bytes]

    value = Response.model_construct(children=("already text", payload))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        expected = value.model_dump(mode="json", by_alias=True)
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("position", ["list", "tuple", "model"])
def test_json_fallback_unvalidated_subtrees_keep_enclosing_model_config_and_exclusions(position):
    from pydantic import ConfigDict, Field

    class Row(BaseModel):
        payload: bytes
        secret: str = Field("hidden", exclude=True)

    annotation = {"list": list[bytes], "tuple": tuple[bytes, ...], "model": Row}[position]

    class Child(BaseModel):
        model_config = ConfigDict(ser_json_bytes="hex")
        data: annotation

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes="base64")
        child: Child

        def model_dump(self, **kwargs):
            return super().model_dump(exclude={"child": {"data": {1}}} if position != "model" else None, **kwargs)

    data = {"list": (b"test", b"hidden"), "tuple": [b"test", b"hidden"], "model": {"payload": b"test"}}[position]
    value = Response(child=Child.model_construct(data=data))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        expected = value.model_dump(mode="json", by_alias=True)
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


def test_json_fallback_model_and_sequence_subclasses_still_overlay_bytes():
    class Child(BaseModel):
        payload: bytes

    class Subclass(Child):
        pass

    class Sequence(list):
        pass

    class Pair(tuple):
        pass

    class Response(BaseModel):
        child: Child
        items: list[Child]
        pair: tuple[Child, ...]

    child = Subclass(payload=b"\xff")
    value = Response.model_construct(child=child, items=Sequence([child]), pair=Pair([child]))
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {
        "child": {"payload": "/w=="}, "items": [{"payload": "/w=="}], "pair": [{"payload": "/w=="}],
    }


def test_json_fallback_model_dump_added_missing_field_keeps_json_mode():
    class Response(BaseModel):
        payload: bytes

        def model_dump(self, **kwargs):
            return {**super().model_dump(**kwargs), "payload": "already text"}

    value = Response.model_construct()
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {"payload": "already text"}


def test_json_fallback_overlays_root_model_bytes():
    from pydantic import ConfigDict, RootModel

    class Response(RootModel[bytes]):
        model_config = ConfigDict(ser_json_bytes="base64")

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(b"\xfb\xff\xfe\x00"))
    assert json.loads(body) == "+//+AA=="


def test_json_fallback_finds_bytes_in_recursive_schema_definitions():
    class Response(BaseModel):
        payload: bytes
        children: list["Response"]

    value = Response(payload=b"hi", children=[Response(payload=b"hi", children=[])])
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"payload": "aGk=", "children": [{"payload": "aGk=", "children": []}]}


def test_json_fallback_dumps_models_without_bytes_once(monkeypatch):
    class Response(BaseModel):
        message: str

    calls = []
    dump = Response.model_dump

    def counted(self, **kwargs):
        calls.append(kwargs)
        return dump(self, **kwargs)

    monkeypatch.setattr(Response, "model_dump", counted)
    value = Response(message="hello")
    for _ in range(2):
        body, _ = encode_for(negotiate(None, CodecRegistry()), value)
        assert json.loads(body) == {"message": "hello"}
    assert calls == [{"mode": "json", "by_alias": True}] * 2


@pytest.mark.parametrize("payload", [None, b"hi", b"\xff"])
def test_json_fallback_respects_model_dump_exclusions(payload):
    class Response(BaseModel):
        secret: str
        payload: bytes | None = None

        def model_dump(self, **kwargs):
            return super().model_dump(exclude={"secret"}, **kwargs)

    value = Response(secret="hidden", payload=payload)
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    expected = {None: None, b"hi": "aGk=", b"\xff": "/w=="}[payload]
    assert json.loads(body) == {"payload": expected}
    assert value.secret == "hidden"


def test_json_fallback_preserves_unpicklable_schema_defaults_and_callbacks():
    import threading
    from typing import Annotated, Any
    from pydantic import Field, PlainSerializer

    class Formatter:
        def __init__(self):
            self.lock = threading.Lock()

        def format(self, value):
            return f"number:{value}"

    formatter = Formatter()

    class Response(BaseModel):
        lock: Any = Field(default=threading.Lock(), exclude=True, alias="private-lock")
        number: Annotated[int, PlainSerializer(formatter.format, when_used="json")]
        payload: bytes

    value = Response(number=7, payload=b"hi")
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"number": "number:7", "payload": "aGk="}


@pytest.mark.parametrize("wrapped", [False, True])
def test_json_fallback_handles_wrapped_utf8_serialization_errors(wrapped):
    from pydantic_core import PydanticSerializationError

    class Response(BaseModel):
        payload: bytes

        def model_dump(self, **kwargs):
            if kwargs["mode"] == "json":
                if wrapped:
                    try:
                        self.payload.decode("utf-8")
                    except UnicodeDecodeError as error:
                        raise PydanticSerializationError("serialization failed") from error
                raise PydanticSerializationError("Error serializing to JSON: invalid utf-8 sequence of 1 bytes from index 0")
            return super().model_dump(**kwargs)

    with pytest.raises(EncodeError) as raised:
        encode_for(negotiate(None, CodecRegistry()), Response(payload=b"\xff"))
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, PydanticSerializationError)


def test_json_fallback_wraps_unrelated_model_serialization_errors():
    from pydantic import field_serializer
    from pydantic_core import PydanticSerializationError

    class Response(BaseModel):
        payload: bytes

        @field_serializer("payload", when_used="json")
        def fail(self, value):
            raise ValueError("serializer failed")

    with pytest.raises(EncodeError, match="serializer failed") as raised:
        encode_for(negotiate(None, CodecRegistry()), Response(payload=b"hi"))
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, PydanticSerializationError)


@pytest.mark.parametrize("shape", ["dict-length", "dict-order", "dict-key", "list-length"])
def test_json_fallback_leaves_divergent_model_shapes_unchanged(shape):
    from pydantic import model_serializer

    plain = {
        "dict-length": {"first": "one"},
        "dict-order": {"second": "two", "first": "one"},
        "dict-key": {"other": "one", "second": "two"},
        "list-length": ["one"],
    }[shape]

    class Response(BaseModel):
        payload: bytes

        @model_serializer(mode="plain")
        def serialize(self, info):
            if info.mode == "json":
                return plain
            if shape == "list-length":
                return [b"one", b"two"]
            return {"first": b"one", "second": "two"}

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(payload=b"hi"))
    assert json.loads(body) == plain


def test_json_fallback_cache_does_not_retain_model_classes():
    import gc
    import weakref

    def encode_temporary_model():
        class Response(BaseModel):
            payload: bytes

        body, _ = encode_for(negotiate(None, CodecRegistry()), Response(payload=b"hi"))
        assert json.loads(body) == {"payload": "aGk="}
        return weakref.ref(Response)

    model = encode_temporary_model()
    gc.collect()
    assert model() is None


def test_json_fallback_uses_model_dump_without_pydantic():
    class Response:
        def model_dump(self, *, mode, by_alias):
            assert mode == "json" and by_alias
            return {"value": math.inf}

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response())
    assert body == b'{"value":null}'


def test_json_fallback_replaces_nested_non_finite_values_without_mutation():
    nested = [math.nan, {"positive": math.inf, "negative": -math.inf}, ["é", None, 2]]
    value = {"values": nested, "finite": 1.5}
    body, headers = encode_for(negotiate(None, CodecRegistry()), value)
    assert body == '{"values":[null,{"positive":null,"negative":null},["é",null,2]],"finite":1.5}'.encode("utf-8")
    assert headers["Content-Type"] == "application/json"
    assert value["values"] is nested
    assert math.isnan(nested[0])
    assert nested[1] == {"positive": math.inf, "negative": -math.inf}


def test_json_fallback_writes_enum_values_and_keys():
    class Color(Enum):
        red = "red"
        ratio = 0.5

    class Level(IntEnum):
        high = 3

    value = {"color": Color.red, "levels": [Level.high, Color.ratio], Color.red: 1, Level.high: 2, math.inf: 3}
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    from pydantic_core import to_jsonable_python

    expected = to_jsonable_python(value)
    expected["Infinity"] = expected.pop("inf")
    assert body == json.dumps(expected, separators=(",", ":")).encode()


def test_json_fallback_rejects_circular_values():
    circular: list = []
    circular.append(circular)
    with pytest.raises(EncodeError, match="circular or nested too deeply") as raised:
        encode_for(negotiate(None, CodecRegistry()), circular)
    assert raised.value.code == "json"


@pytest.mark.parametrize("factory", [bytes, bytearray])
@pytest.mark.parametrize("nested", [False, True])
def test_json_fallback_writes_bytes_without_a_codec(factory, nested):
    value = factory(b"\xfb\xff\xff\x00")
    body, _ = encode_for(negotiate(None, CodecRegistry()), {"chunks": [value]} if nested else value)
    assert json.loads(body) == ({"chunks": ["+///AA=="]} if nested else "+///AA==")
    assert value == factory(b"\xfb\xff\xff\x00")


@pytest.mark.parametrize("payload,expected", [(b"ab", "YWI="), (b"\x00\xff", "AP8=")])
def test_json_fallback_plain_codec_writes_declared_bytes(payload, expected):
    codec = compile_ir({"kind": "struct", "fields": [
        {"name": "b", "type": {"kind": "bytes"}},
        {"name": "l", "type": {"kind": "array", "element": {"kind": "bytes"}}},
    ]})
    registry = CodecRegistry([codec])
    value = {"b": payload, "l": [b"ab"]}
    body, headers = encode_for(negotiate("application/json", registry), value)
    assert json.loads(body) == {"b": expected, "l": ["YWI="]}
    assert headers["Content-Type"] == "application/json"
    assert decode_response(headers["Content-Type"], body, registry) == ("json", value)


@pytest.mark.parametrize("subclasses", [False, True])
def test_json_fallback_plain_containers_use_the_model_declared_overlay(subclasses):
    from typing import Any
    from pydantic import ConfigDict, Field, field_serializer

    class Mapping(dict):
        pass

    class Sequence(list):
        pass

    class Tuple(tuple):
        pass

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes="hex", extra="allow")
        payload: bytes = Field(serialization_alias="data")
        raw: Any
        secret: str

        @field_serializer("secret", when_used="json")
        def redact(self, value):
            return "REDACTED"

    mapping, sequence, pair = (Mapping, Sequence, Tuple) if subclasses else (dict, list, tuple)
    model = Response(payload=b"\x00\xff", raw=b"ab", secret="secret", extra=b"ab")
    value = mapping({b"key": sequence([pair((b"ab", bytearray(b"\x00\xff"))), sequence([model])])})
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"key": [["YWI=", "AP8="], [{
        "data": "AP8=", "raw": "6162", "secret": "REDACTED", "extra": "6162",
    }]]}
    assert value[b"key"][0] == (b"ab", bytearray(b"\x00\xff"))
    assert value[b"key"][1][0] is model


def test_json_fallback_plain_container_walk_is_iterative():
    from hyperfly.http import _json_value

    value = b"\x00\xff"
    for _ in range(2000):
        value = {"items": (value,)}
    converted = _json_value(value)
    for _ in range(2000):
        converted = converted["items"][0]
    assert converted == "AP8="
    with pytest.raises(EncodeError, match="circular or nested too deeply") as raised:
        encode_for(negotiate(None, CodecRegistry()), value)
    assert raised.value.code == "json"


def test_json_fallback_plain_container_walk_allows_shared_values():
    shared = {"payload": b"ab"}
    body, _ = encode_for(negotiate(None, CodecRegistry()), [shared, shared])
    assert json.loads(body) == [{"payload": "YWI="}, {"payload": "YWI="}]
    assert shared == {"payload": b"ab"}


def test_encoder_limit_falls_back_to_base64_bytes():
    codec = compile_ir({"kind": "bytes"}, limits=Limits(max_byte_length=0))
    registry = CodecRegistry([codec])
    failures = []
    body, headers = encode_for(
        negotiate(codec.fingerprint, registry), b"\xff",
        on_fallback=lambda reason, error: failures.append((reason, error.code)),
    )
    assert failures == [("encoder-limit", "limit")]
    assert body == b'"/w=="'
    assert headers["Content-Type"] == "application/json"
    assert decode_response(headers["Content-Type"], body, registry) == ("json", b"\xff")


def _decode_json_pair(body, registry):
    return [decode_response("application/json", body, registry), _request(body, registry=registry)]


@pytest.mark.parametrize("value", [None, False, 1, {}, [], "é", "\ud800", "AA== ", "=AA=", "===="])
def test_json_bytes_positions_reject_invalid_values(value):
    registry = CodecRegistry([compile_ir({"kind": "bytes"})])
    body = json.dumps(value).encode("utf-8")
    with pytest.raises(DecodeError) as raised:
        decode_response("application/json", body, registry)
    assert raised.value.code == "json"
    error = _refusal(body, registry=registry)
    assert (error.status, error.reason, error.__cause__.code) == (400, "malformed-json", "json")


def test_json_uses_the_first_registry_codec_for_bytes_positions():
    binary = compile_ir({"kind": "bytes"})
    text = compile_ir({"kind": "string"})
    assert accept_header(CodecRegistry([binary, text]).fingerprints).startswith(binary.fingerprint)
    for registry, expected in [
        (CodecRegistry([binary, text]), b"\x00"),
        (CodecRegistry([text, binary]), "AA=="),
        (CodecRegistry(), "AA=="),
    ]:
        assert _decode_json_pair(b'"AA=="', registry) == [("json", expected)] * 2
    assert _decode_json_pair(b'"not base64"', CodecRegistry()) == [("json", "not base64")] * 2


def test_json_conversion_checks_shapes_and_required_fields():
    ir = {"kind": "struct", "fields": [
        {"name": "missing", "type": {"kind": "bytes"}},
        {"name": "optional", "type": {"kind": "bytes"}, "optional": True},
        {"name": "nullable", "type": {"kind": "bytes"}, "nullable": True},
        {"name": "array", "type": {"kind": "array", "element": {"kind": "bytes"}}},
        {"name": "child", "type": {"kind": "struct", "fields": [{"name": "data", "type": {"kind": "bytes"}}]}},
        {"name": "text", "type": {"kind": "string"}},
        {"name": "wrapped", "type": {"kind": "nullable", "inner": {"kind": "bytes"}}},
    ]}
    registry = CodecRegistry([compile_ir(ir)])
    for value in [42, [], None, {"nullable": None, "array": "bad shape", "child": ["AA=="], "text": 12, "extra": "AA==", "wrapped": None}]:
        body = json.dumps(value).encode()
        with pytest.raises(DecodeError) as raised:
            decode_response("application/json", body, registry)
        assert raised.value.code == "json"
        error = _refusal(body, registry=registry)
        assert (error.status, error.reason, error.__cause__.code) == (400, "malformed-json", "json")
    body = b'{"missing":"","optional":"AA==","nullable":"/w==","array":["AAE="],"child":{"data":""},"text":"AA==","wrapped":"AA==","extra":"ignored"}'
    expected = {"missing": b"", "optional": b"\x00", "nullable": b"\xff", "array": [b"\x00\x01"], "child": {"data": b""}, "text": "AA==", "wrapped": b"\x00"}
    assert _decode_json_pair(body, registry) == [("json", expected)] * 2


def test_json_bytes_walk_handles_deep_arrays():
    ir = {"kind": "bytes"}
    expected = b"\x00"
    for _ in range(200):
        ir = {"kind": "array", "element": ir}
        expected = [expected]
    registry = CodecRegistry([compile_ir(ir)])
    body = b"[" * 200 + b'"AA=="' + b"]" * 200
    assert _decode_json_pair(body, registry) == [("json", expected)] * 2


def test_json_bytes_walk_does_not_copy_deep_schema_from_extra_frames():
    ir = {"kind": "bytes"}
    for _ in range(490):
        ir = {"kind": "array", "element": ir}
    recursion_limit = sys.getrecursionlimit()
    try:
        sys.setrecursionlimit(max(recursion_limit, 2000))
        registry = CodecRegistry([compile_ir(ir)])
    finally:
        sys.setrecursionlimit(recursion_limit)

    def decode(frames):
        if frames:
            return decode(frames - 1)
        return _decode_json_pair(b"[" * 490 + b'"AA=="' + b"]" * 490, registry)

    for kind, value in decode(20):
        assert kind == "json"
        for _ in range(490):
            assert isinstance(value, list) and len(value) == 1
            value = value[0]
        assert value == b"\x00"


@pytest.mark.parametrize("validate", [False, True])
@pytest.mark.parametrize("limited", [False, True])
def test_json_model_bytes_fallback_and_plain_decoding(validate, limited):
    from pydantic import ConfigDict, Field, field_validator

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes="hex")
        payload: bytes = Field(alias="data")
        chunks: list[bytes | None]

        @field_validator("payload", mode="before")
        @classmethod
        def nonempty(cls, value):
            if not value:
                raise ValueError("empty payload")
            return value

    codec = compile_model(Response, validate=validate, limits=Limits(max_byte_length=0) if limited else None)
    registry = CodecRegistry([codec])
    model = Response(data=b"\xff", chunks=[b"\xfb\xff\xff", None])
    decision = negotiate(codec.fingerprint if limited else None, registry)
    body, headers = encode_for(decision, model)
    assert json.loads(body) == {"data": "/w==", "chunks": ["+///", None]}
    assert headers["Content-Type"] == "application/json"
    expected = {"data": b"\xff", "chunks": [b"\xfb\xff\xff", None]}
    assert _decode_json_pair(body, registry) == [("json", expected)] * 2
    assert _decode_json_pair(b'{"data":"","chunks":[]}', registry) == [("json", {"data": b"", "chunks": []})] * 2


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_json_fallback_replaces_root_non_finite_values(value):
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert body == b"null"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize("template", ["{}", '[{{"value":{}}}]'])
@pytest.mark.parametrize("as_bytes", [False, True])
def test_json_response_rejects_non_finite_tokens(token, template, as_bytes):
    body = template.format(token)
    if as_bytes:
        body = body.encode("utf-8")
    with pytest.raises(DecodeError) as raised:
        decode_response("application/json", body, CodecRegistry())
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, json.JSONDecodeError)


@pytest.mark.parametrize("body", ["{", b"{", b'"\xff"', b"[" * 100_000, ""])
def test_malformed_json_response_is_a_json_decode_error(body):
    with pytest.raises(DecodeError) as raised:
        decode_response(None, body, CodecRegistry())
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, (ValueError, RecursionError))


def test_json_response_strips_a_byte_order_mark():
    assert decode_response("application/json", "\ufeff[1]".encode(), CodecRegistry()) == ("json", [1])


def test_json_response_accepts_non_finite_names_in_strings():
    value = ["NaN", "Infinity", "-Infinity"]
    assert decode_response("application/json", json.dumps(value), CodecRegistry()) == ("json", value)


def test_model_codec_negotiation_and_artifact_discovery():
    class Response(BaseModel):
        id: str

    codec = compile_model(Response, validate=True)
    registry = CodecRegistry([codec])
    assert registry.get(codec.fingerprint) is codec
    decision = negotiate(accept_header([codec.fingerprint]), registry)
    assert decision.codec is codec
    value = Response(id="abc")
    body, headers = encode_for(decision, value)
    assert headers["Content-Type"] == HYPERFLY_MEDIA_TYPE
    assert headers["Hyperfly-Codec"] == codec.fingerprint
    assert decode_response(headers["Content-Type"], body, registry) == ("hyperfly", value)
    served = serve_artifact(f"/.well-known/hyperfly/{codec.fingerprint}", registry)
    assert served.status == 200
    assert served.body == codec.artifact


def test_json_fallback_uses_wire_aliases():
    from pydantic import Field

    class Response(BaseModel):
        internal: str = Field(alias="external")

    body, _ = encode_for(negotiate(None, CodecRegistry()), Response(external="hello"))
    assert body == b'{"external":"hello"}'
    assert Response.model_validate_json(body) == Response(external="hello")


def test_json_fallback_escapes_lone_surrogates():
    body, _ = encode_for(negotiate(None, CodecRegistry()), {"v": "\ud800", "w": "é"})
    assert body == '{"v":"\\ud800","w":"é"}'.encode("utf-8")
    assert json.loads(body) == {"v": "\ud800", "w": "é"}


OPT_OUTS = [
    "application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;q=0.",
    "application/vnd.hyperfly;q=0.0",
    "application/vnd.hyperfly;q=0.00",
    "APPLICATION/VND.HYPERFLY ; Q=0.000",
    "application/*;q=0",
    "*/*;q=0",
    "application/json, \tapplication/vnd.hyperfly\t;\tq \t=\t0\t",
    "application/vnd.hyperfly;q=0, application/vnd.hyperfly;q=1",
    "application/*;q=0, */*;q=1",
    "*/*;q=1, application/*;q=0",
    "*/*;q=0, application/vnd.hyperfly;q=abc",
    "*/*;q=0, application/vnd.hyperfly;q=1.001",
    "*/*;q=0, application/vnd.hyperfly;q=0\n",
    "*/*;q=0, application/vnd.hyperfly;version=2;q=1",
    ",".join(["invalid"] * 31) + ",application/vnd.hyperfly;q=0",
    "," * 31 + "application/vnd.hyperfly;q=0",
    '*/*;q=0,application/vnd.hyperfly;foo="x,application/vnd.hyperfly;q=1,y"',
    'text/html;foo="x\\\\",application/vnd.hyperfly;q=0',
    'text/html;foo="x,y",' * 31 + "application/vnd.hyperfly;q=0",
]

NOT_OPT_OUTS = [
    "application/vnd.hyperfly;q=0.001",
    "application/vnd.hyperfly-x;q=0",
    "*/*;q=0, application/vnd.hyperfly",
    "application/*;q=0, application/vnd.hyperfly;q=0.5",
    "application/vnd.hyperfly, */*;q=0",
    "application/vnd.hyperfly;q=1, application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;version=2;q=0",
    "application/vnd.hyperfly; version=1; q=0; charset=x",
    "application/vnd.hyperfly",
    "application/vnd.hyperfly;q=1.",
    "application/vnd.hyperfly;q=1.000",
    "application/json",
    "application/vnd.hyperfly;q=abc",
    "application/vnd.hyperfly;q=0.0000",
    "application/vnd.hyperfly;q=0x",
    "application/vnd.hyperfly;q=1.001, */*;q=0.1",
    "application/vnd.hyperfly;q=2",
    "application/vnd.hyperfly;q=.0",
    "application/vnd.hyperfly;q=0;invalid",
    "application/vnd.hyperfly;q=0;",
    'application/vnd.hyperfly;q="0"',
    'application/vnd.hyperfly; version="x;q=0"',
    "application/vnd.hyperfly;q=0\n",
    "application/vnd.hyperfly;q=٠",
    " application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;q=0;q=1",
    "application/vnd.hyperfly;q=1;q=0",
    ",".join(["invalid"] * 32) + ",application/vnd.hyperfly;q=0",
    "," * 32 + "application/vnd.hyperfly;q=0",
    'text/html;foo="x,application/vnd.hyperfly;q=0,y"',
    'text/html;foo="x\\",application/vnd.hyperfly;q=0,y"',
    'text/html;foo="x,application/vnd.hyperfly;q=0',
    'text/html;foo="x,y",' * 32 + "application/vnd.hyperfly;q=0",
    "",
    None,
]


@pytest.mark.parametrize("accept", OPT_OUTS)
def test_accept_opts_out_of_binary(accept):
    registry = CodecRegistry([CODEC_A])
    assert negotiate(CODEC_A.fingerprint, registry, http_accept=accept) == negotiate(None, registry).__class__(
        "json",
        {"Vary": "Hyperfly-Accept, Accept", "Content-Type": "application/json", "Hyperfly-Offer": CODEC_A.fingerprint},
        reason="accept-refused",
    )


@pytest.mark.parametrize("accept", NOT_OPT_OUTS)
def test_accept_does_not_opt_out(accept):
    registry = CodecRegistry([CODEC_A])
    decision = negotiate(CODEC_A.fingerprint, registry, http_accept=accept)
    assert decision.kind == "hyperfly"
    assert decision.reason is None


def test_accept_opt_out_preserves_the_configured_offer():
    registry = CodecRegistry([CODEC_A])
    decision = negotiate(CODEC_A.fingerprint, registry, http_accept="application/vnd.hyperfly;q=0", offer=CODEC_B.fingerprint)
    assert decision.headers["Hyperfly-Offer"] == CODEC_B.fingerprint


def test_accept_without_hyperfly_accept_stays_json():
    registry = CodecRegistry([CODEC_A])
    assert negotiate(None, registry, http_accept="application/vnd.hyperfly").kind == "json"
    assert negotiate(None, registry, http_accept="application/json").reason == "no-hyperfly-accept"


def test_fallback_reasons():
    registry = CodecRegistry([CODEC_A])
    hit = accept_header([CODEC_A.fingerprint])
    assert negotiate(hit, registry, enabled=False).reason == "disabled"
    assert negotiate(hit, registry, http_accept="*/*;q=0").reason == "accept-refused"
    assert negotiate(None, registry).reason == "no-hyperfly-accept"
    assert negotiate("", registry).reason == "no-hyperfly-accept"
    assert negotiate("f" * 32, registry).reason == "no-match"
    assert negotiate("nope", registry).reason == "no-match"
    assert negotiate(hit, registry).reason is None


def test_every_decision_varies_on_both_headers():
    registry = CodecRegistry([CODEC_A])
    hit = accept_header([CODEC_A.fingerprint])
    for decision in (
        negotiate(hit, registry),
        negotiate(None, registry),
        negotiate("f" * 32, registry),
        negotiate(hit, registry, enabled=False),
        negotiate(hit, registry, http_accept="application/vnd.hyperfly;q=0"),
    ):
        assert decision.headers["Vary"] == "Hyperfly-Accept, Accept"


def _assert_bounded(call, *, peak=64 * 1024, seconds=1.0):
    started = time.perf_counter()
    result = call()
    assert time.perf_counter() - started < seconds
    tracemalloc.start()
    try:
        before = tracemalloc.get_traced_memory()[0]
        call()
        assert tracemalloc.get_traced_memory()[1] - before < peak
    finally:
        tracemalloc.stop()
    return result


HOSTILE_ACCEPTS = [
    "x" * (1 << 20),
    "," * (1 << 20),
    ";" * (1 << 20),
    "=" * (1 << 20),
    " " * (1 << 20) + "application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;q=" + "0" * (1 << 20),
    "application/vnd.hyperfly;" + " " * (1 << 20) + "q=0",
    '"' * (1 << 20),
    '"' + "\\" * (1 << 20),
    '"' + "\\x" * (1 << 19) + '"',
    '"' + "\\," * (1 << 19),
    'a="x" ' * (1 << 17) + ",",
    '*/*;q=1;a="' + "," * (1 << 20),
    "application/vnd.hyperfly;q=0;" * (1 << 15),
    "\\" * (1 << 20),
    '\\"' * (1 << 16),
    '"a"\\' * (1 << 15),
    '"' + '\\"' * (1 << 16),
    '"\\\\"' * (1 << 15),
    "*/*;q=0" + " " * (1 << 20) + ",application/vnd.hyperfly",
]


@pytest.mark.parametrize("accept", HOSTILE_ACCEPTS, ids=range(len(HOSTILE_ACCEPTS)))
def test_hostile_accept_headers_are_bounded(accept):
    registry = CodecRegistry([CODEC_A])
    decision = _assert_bounded(lambda: negotiate(CODEC_A.fingerprint, registry, http_accept=accept))
    assert decision.kind in ("json", "hyperfly")


def test_refused_encodes_fall_back_to_json_and_report():
    limited = compile_ir({"kind": "array", "element": {"kind": "literal", "value": "x"}}, limits=Limits(max_amplification=1))
    deep = compile_ir(
        {"kind": "array", "element": {"kind": "array", "element": {"kind": "int"}}}, limits=Limits(max_depth=1)
    )
    for codec, value, code in ((limited, ["x"] * 5, "limit"), (deep, [[1]], "depth")):
        decision = negotiate(codec.fingerprint, CodecRegistry([codec]))
        assert decision.kind == "hyperfly"
        calls: list = []
        body, headers = encode_for(decision, value, on_fallback=lambda reason, error: calls.append((reason, error)))
        assert headers == {
            "Vary": "Hyperfly-Accept, Accept",
            "Content-Type": "application/json",
            "Hyperfly-Offer": codec.fingerprint,
        }
        assert decode_response(headers["Content-Type"], body, CodecRegistry([codec])) == ("json", value)
        assert len(calls) == 1
        assert calls[0][0] == "encoder-limit"
        assert isinstance(calls[0][1], EncodeError) and calls[0][1].code == code
        assert encode_for(decision, value)[1]["Content-Type"] == "application/json"


def test_other_encode_errors_still_raise_without_reporting():
    calls: list = []
    decision = negotiate(CODEC_A.fingerprint, CodecRegistry([CODEC_A]))
    with pytest.raises(EncodeError) as raised:
        encode_for(decision, {"id": 7}, on_fallback=lambda *args: calls.append(args))
    assert raised.value.code == "type"
    assert calls == []


@pytest.mark.parametrize("kind", ["short body", "wrong magic", "wrong version"])
def test_response_envelope_is_validated(kind):
    data = bytearray(CODEC_A.encode(VALUE))
    if kind == "short body":
        data = data[: HEADER_SIZE - 1]
    if kind == "wrong magic":
        data[1] = 0
    if kind == "wrong version":
        data[2] = WIRE_VERSION + 1
    for registry in (CodecRegistry(), CodecRegistry([CODEC_A])):
        with pytest.raises(DecodeError) as raised:
            decode_response(HYPERFLY_MEDIA_TYPE, bytes(data), registry)
        assert raised.value.code == "header"


@pytest.mark.parametrize("content_type", ["APPLICATION/VND.HYPERFLY", "application/vnd.hyperfly; charset=x", " application/vnd.hyperfly\t"])
def test_response_content_type_matches_the_essence(content_type):
    registry = CodecRegistry([CODEC_A])
    assert decode_response(content_type, CODEC_A.encode(VALUE), registry) == ("hyperfly", VALUE)


def test_response_prefix_lookalike_is_json():
    registry = CodecRegistry([CODEC_A])
    assert decode_response(f"{HYPERFLY_MEDIA_TYPE}-x", json.dumps(VALUE), registry) == ("json", VALUE)


class Chunks:
    """A chunk source that records how far it was read and whether it was closed."""

    def __init__(self, chunks, *, fail=None, close_fails=False):
        self._chunks = iter(chunks)
        self.pulls = 0
        self.closed = False
        self._fail = fail
        self._close_fails = close_fails

    def __iter__(self):
        return self

    def __next__(self):
        self.pulls += 1
        if self._fail is not None:
            raise self._fail
        return next(self._chunks)

    def close(self):
        self.closed = True
        if self._close_fails:
            raise RuntimeError("close failed")


def _request(body, *, content_type="application/json", codec_header=None, registry=None, **options):
    return decode_request(content_type, codec_header, body, CodecRegistry([CODEC_A]) if registry is None else registry, **options)


def _refusal(body, **options):
    with pytest.raises(RequestError) as raised:
        _request(body, **options)
    return raised.value


def test_binary_request_round_trip():
    assert _request(CODEC_A.encode(VALUE), content_type=HYPERFLY_MEDIA_TYPE) == DecodedRequest("hyperfly", VALUE)
    kind, value = _request(json.dumps(VALUE).encode())
    assert (kind, value) == ("json", VALUE)


def test_unknown_fingerprint_is_415_with_an_offer():
    data = bytearray(CODEC_A.encode(VALUE))
    data[3:HEADER_SIZE] = b"\xff" * 16
    for registry, headers in ((CodecRegistry([CODEC_A]), {"Hyperfly-Offer": CODEC_A.fingerprint}), (CodecRegistry(), {})):
        error = _refusal(bytes(data), content_type=HYPERFLY_MEDIA_TYPE, registry=registry)
        assert (error.status, error.reason, error.headers) == (415, "unknown-codec", headers)
    error = _refusal(CODEC_B.encode({"id": "x", "n": 1}), content_type=HYPERFLY_MEDIA_TYPE)
    assert (error.status, error.headers) == (415, {"Hyperfly-Offer": CODEC_A.fingerprint})


@pytest.mark.parametrize("content_type", ["text/plain", f"{HYPERFLY_MEDIA_TYPE}-x", "", "foo+json", "+json",
    "application/+json", "/problem+json", "application//problem+json", "application/problem +json",
    "application/problem@+json", "app(lication/problem+json", "application/Kelvin+json"])
def test_unsupported_content_types_are_415_without_reading(content_type):
    chunks = Chunks([CODEC_A.encode(VALUE)])
    error = _refusal(chunks, content_type=content_type, content_length=str(DEFAULT_MAX_BODY_BYTES + 1))
    assert (error.status, error.reason, error.headers) == (415, "unsupported-media-type", {})
    assert chunks.pulls == 0


@pytest.mark.parametrize("content_type", [None, "application/json", "application/problem+json",
    "application/vnd.x+json", "!#$%&'*+-.^_`|~0123456789/!#$%&'*+-.^_`|~0123456789+json",
    " \tAPPLICATION/JSON\t ; charset=utf-8"])
def test_json_content_types(content_type):
    assert _request(json.dumps(VALUE).encode(), content_type=content_type) == ("json", VALUE)


@pytest.mark.parametrize("content_type", ["APPLICATION/VND.HYPERFLY", "application/vnd.hyperfly; charset=x"])
def test_hyperfly_content_type_essence(content_type):
    assert _request(CODEC_A.encode(VALUE), content_type=content_type) == ("hyperfly", VALUE)


@pytest.mark.parametrize("body", [b"{", b'"\xff"', b"", b"NaN", b'{"v":Infinity}', b"[" * 100_000, b"1" * 10_000 + b"x",
    b'"\xed\xa0\x80"'])
def test_malformed_json_is_400(body):
    error = _refusal(body)
    assert (error.status, error.reason, error.headers) == (400, "malformed-json", {})
    assert isinstance(error.__cause__, DecodeError) and error.__cause__.code == "json"
    assert isinstance(error.__cause__.__cause__, (ValueError, RecursionError))


def test_json_body_ignores_the_codec_header():
    assert _request(b'{"id":"abc"}', codec_header="nope") == ("json", VALUE)
    assert _request('﻿{"id":"abc"}'.encode()) == ("json", VALUE)


@pytest.mark.parametrize("header", [None, CODEC_A.fingerprint, f" \t{CODEC_A.fingerprint}\t "])
def test_matching_codec_header_is_accepted(header):
    assert _request(CODEC_A.encode(VALUE), content_type=HYPERFLY_MEDIA_TYPE, codec_header=header) == ("hyperfly", VALUE)


class UncheckedRegistry(CodecRegistry):
    def get(self, fingerprint):
        raise AssertionError("registry must not be consulted")


@pytest.mark.parametrize("header", [CODEC_B.fingerprint, CODEC_A.fingerprint.upper(), "", "malformed",
    f"{CODEC_A.fingerprint},{CODEC_A.fingerprint}", f"\n{CODEC_A.fingerprint}", "x" * (1 << 20)])
def test_contradicting_codec_header_is_400_before_lookup(header):
    error = _refusal(CODEC_A.encode(VALUE), content_type=HYPERFLY_MEDIA_TYPE, codec_header=header, registry=UncheckedRegistry())
    assert (error.status, error.reason, error.headers) == (400, "codec-mismatch", {})


@pytest.mark.parametrize("kind", ["short body", "wrong magic", "wrong version", "empty body"])
def test_malformed_envelope_is_400(kind):
    data = bytearray(CODEC_A.encode(VALUE))
    if kind == "short body":
        data = data[: HEADER_SIZE - 1]
    if kind == "wrong magic":
        data[0] = 0
    if kind == "wrong version":
        data[2] = WIRE_VERSION + 1
    if kind == "empty body":
        data = bytearray()
    error = _refusal(bytes(data), content_type=HYPERFLY_MEDIA_TYPE, codec_header=CODEC_B.fingerprint, registry=UncheckedRegistry())
    assert (error.status, error.reason, error.headers) == (400, "malformed-envelope", {})


@pytest.mark.parametrize("cut", [0, 1])
def test_undecodable_body_is_400(cut):
    data = CODEC_A.encode(VALUE)
    data = data[:HEADER_SIZE] if cut == 0 else data + b"\x00"
    error = _refusal(data, content_type=HYPERFLY_MEDIA_TYPE)
    assert (error.status, error.reason) == (400, "undecodable")
    assert isinstance(error.__cause__, DecodeError)


def test_decoder_limits_are_400():
    limited = compile_ir({"kind": "array", "element": {"kind": "literal", "value": "x"}}, limits=Limits(max_amplification=1))
    data = compile_ir({"kind": "array", "element": {"kind": "literal", "value": "x"}}).encode(["x"] * 5)
    error = _refusal(data, content_type=HYPERFLY_MEDIA_TYPE, registry=CodecRegistry([limited]))
    assert (error.status, error.reason) == (400, "undecodable")
    assert error.__cause__.code == "limit"


def test_unexpected_codec_errors_propagate():
    class Broken:
        fingerprint = CODEC_A.fingerprint

        def decode(self, data):
            raise RuntimeError("codec failure")

    with pytest.raises(RuntimeError, match="codec failure"):
        _request(CODEC_A.encode(VALUE), content_type=HYPERFLY_MEDIA_TYPE, registry=CodecRegistry([Broken()]))


def test_status_order():
    unknown = bytearray(CODEC_B.encode({"id": "x", "n": 1}))
    unknown[3:HEADER_SIZE] = b"\xff" * 16
    cases = [
        (dict(content_type="text/plain", body=b"garbage"), 415, "unsupported-media-type"),
        (dict(content_type="text/plain", body=b"x" * 10, max_bytes=1), 415, "unsupported-media-type"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=bytes(unknown), max_bytes=HEADER_SIZE - 1), 413, "too-large"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=b"\x00" * 4, max_bytes=3, codec_header="x"), 413, "too-large"),
        (dict(body=b"{" * 4, max_bytes=3), 413, "too-large"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=b"\x00" * 4, codec_header="x"), 400, "malformed-envelope"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=bytes(unknown), codec_header=CODEC_A.fingerprint), 400, "codec-mismatch"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=bytes(unknown)), 415, "unknown-codec"),
        (dict(content_type=HYPERFLY_MEDIA_TYPE, body=CODEC_A.encode(VALUE)[:HEADER_SIZE]), 400, "undecodable"),
    ]
    for options, status, reason in cases:
        body = options.pop("body")
        error = _refusal(body, **options)
        assert (error.status, error.reason) == (status, reason), options
        if status != 415 or reason != "unknown-codec":
            assert error.headers == {}


@pytest.mark.parametrize("max_bytes", [-1, 2**53, 1.5, math.inf, math.nan, True, "1", None])
def test_invalid_max_bytes_is_an_options_error_without_reading(max_bytes):
    chunks = Chunks([b"0"])
    for read in (lambda: _request(chunks, max_bytes=max_bytes), lambda: read_body(chunks, max_bytes=max_bytes)):
        with pytest.raises(HyperflyError) as raised:
            read()
        assert (raised.value.code, str(raised.value)) == ("options", "max_bytes: must be a non-negative safe integer")
    assert chunks.pulls == 0


def test_max_bytes_reads_an_int_subclass_as_its_value():
    class Size(int):
        def __int__(self):
            return 100

        def __gt__(self, other):
            return False

    with pytest.raises(RequestError) as raised:
        read_body([b"[1,2]"], max_bytes=Size(2))
    assert raised.value.status == 413


def test_stream_stops_and_closes_as_soon_as_it_passes_the_cap():
    chunks = Chunks([b"123"] * 1000)
    error = _refusal(chunks, max_bytes=5)
    assert (error.status, error.reason, error.headers) == (413, "too-large", {})
    assert chunks.pulls == 2
    assert chunks.closed


def test_413_survives_a_failing_close():
    chunks = Chunks([b"12"] * 10, close_fails=True)
    assert _refusal(chunks, max_bytes=1).status == 413
    assert chunks.closed


def test_413_from_a_generator_closes_it():
    pulled = []

    def stream():
        try:
            while True:
                pulled.append(1)
                yield b"xx"
        finally:
            pulled.append("closed")

    assert _refusal(stream(), max_bytes=3).status == 413
    assert pulled == [1, 1, "closed"]


def test_a_failing_stream_is_400():
    error = _refusal(Chunks([], fail=ConnectionResetError("client aborted")))
    assert (error.status, error.reason) == (400, "unreadable")
    assert isinstance(error.__cause__, ConnectionResetError)


def test_empty_chunks_within_a_zero_byte_limit():
    chunks = Chunks([b""] * 100_000)
    error = _refusal(chunks, max_bytes=0)
    assert (error.status, error.reason) == (400, "malformed-json")
    assert chunks.pulls == 100_001


def test_zero_and_large_limits():
    assert _refusal(b"0", max_bytes=0).status == 413
    assert _request(b"0", max_bytes=2**53 - 1, registry=CodecRegistry()) == ("json", 0)
    assert read_body(b"", max_bytes=0) == b""


def test_exactly_max_bytes_across_chunks_counts_utf8_bytes():
    data = '"é"'.encode()
    chunks = Chunks([data[:2], memoryview(data[2:]), bytearray()])
    assert _request(chunks, max_bytes=len(data), registry=CodecRegistry()) == ("json", "é")
    assert _refusal(Chunks([data[:2], data[2:]]), max_bytes=len(data) - 1).status == 413


@pytest.mark.parametrize("content_length", [str(DEFAULT_MAX_BODY_BYTES + 1), DEFAULT_MAX_BODY_BYTES + 1, " 2\t",
    "0" * 100 + "2", "9" * (1 << 20)])
def test_oversized_content_length_is_413_without_reading(content_length):
    chunks = Chunks([b"0"])
    max_bytes = 1 if content_length in (" 2\t", "0" * 100 + "2") else DEFAULT_MAX_BODY_BYTES
    error = _assert_bounded(lambda: _refusal(chunks, max_bytes=max_bytes, content_length=content_length), peak=2 << 20)
    assert error.status == 413
    assert chunks.pulls == 0


@pytest.mark.parametrize("content_length", ["-1", "1.5", "1x", "", "٢", "0x10", "1", "0" * 100 + "1",
    "+2", "2 2", " \t \t ", "\n2", "2\r", "\v2", "2\f", "\u00a02\u00a0", "\u20032"])
def test_other_content_lengths_are_ignored(content_length):
    assert _request(Chunks([b"0"]), max_bytes=1, content_length=content_length, registry=CodecRegistry()) == ("json", 0)
    assert _refusal(Chunks([b"10"]), max_bytes=1, content_length=content_length).status == 413


def test_content_length_cannot_raise_the_cap():
    assert _refusal(Chunks([b"12"]), max_bytes=1, content_length="1").status == 413


def test_oversized_bytes_body_is_413():
    assert read_body(bytearray(b"ab"), max_bytes=2) == b"ab"
    assert _refusal(b"x" * (DEFAULT_MAX_BODY_BYTES + 1)).status == 413


def test_hostile_request_headers_are_bounded():
    big = "x" * (1 << 20)
    for options in (
        dict(content_type=big, codec_header=None),
        dict(content_type=HYPERFLY_MEDIA_TYPE, codec_header=" " * (1 << 20)),
    ):
        error = _assert_bounded(lambda: _refusal(CODEC_A.encode(VALUE), **options), peak=4 << 20)
        assert error.status in (400, 415)
    assert _assert_bounded(lambda: _refusal(b"x", content_type="a/" + "+" * (1 << 20)), peak=4 << 20).status == 415


def test_failed_model_validation_in_a_request_is_400():
    from pydantic import field_validator

    class Order(BaseModel):
        id: str

        @field_validator("id")
        @classmethod
        def _short(cls, value: str) -> str:
            if len(value) > 3:
                raise ValueError("too long")
            return value

    codec = compile_model(Order, validate=True)
    registry = CodecRegistry([codec])
    assert _request(codec.encode({"id": "abc"}), content_type=HYPERFLY_MEDIA_TYPE, registry=registry) == (
        "hyperfly",
        Order(id="abc"),
    )
    error = _refusal(compile_ir(codec.ir).encode({"id": "abcd"}), content_type=HYPERFLY_MEDIA_TYPE, registry=registry)
    assert (error.status, error.reason) == (400, "undecodable")
    assert error.__cause__.code == "validation"


class _ExplodingIterable:
    def __iter__(self):
        raise ConnectionResetError("client aborted")


def _closed_reader():
    import io

    reader = io.BufferedReader(io.BytesIO(b"[1]"))
    reader.close()
    return reader


@pytest.mark.parametrize(
    "make,cause",
    [
        (_ExplodingIterable, ConnectionResetError),
        (_closed_reader, ValueError),
        (lambda: "[1]", TypeError),
        (lambda: [1, 2, 3], TypeError),
        (lambda: [b"[", "1]"], TypeError),
        (lambda: iter([None]), TypeError),
    ],
)
def test_unreadable_bodies_are_400(make, cause):
    for call in (read_body, _request):
        with pytest.raises(RequestError) as raised:
            call(make())
        assert (raised.value.status, raised.value.reason, raised.value.headers) == (400, "unreadable", {})
        assert isinstance(raised.value.__cause__, cause)


def test_chunks_are_copied_from_mutable_buffers():
    buffer = bytearray(b"[1]")
    data = read_body([buffer])
    buffer[1:2] = b"2"
    assert data == b"[1]"


@pytest.mark.parametrize("digits", [4300, 4301, 10_000])
@pytest.mark.parametrize("sign", ["", "-"])
def test_json_integers_past_the_digit_limit_parse_like_json_parse(digits, sign):
    token = sign + "1" * digits
    expected = int(token) if digits <= 4300 else float(sign + "inf")
    for decode in (
        lambda body: decode_response("application/json", body, CodecRegistry())[1],
        lambda body: _request(body.encode(), registry=CodecRegistry()).value,
    ):
        assert decode(token) == expected
        assert decode(f'{{"n":[{token}]}}') == {"n": [expected]}


def test_json_floats_and_big_exponents_parse_like_json_parse():
    assert _request(b"[1e400, -1e400, 1e-400, 0.1]", registry=CodecRegistry()).value == [math.inf, -math.inf, 0.0, 0.1]
    assert _request(b"1" + b"0" * 400 + b".5", registry=CodecRegistry()).value == math.inf
    assert _request(b"0." + b"0" * 100_000 + b"1", registry=CodecRegistry()).value == 0.0


def test_json_nesting_past_the_recursion_limit_is_400(monkeypatch):
    def overflow(*args, **kwargs):
        raise RecursionError("maximum recursion depth exceeded")

    monkeypatch.setattr(json, "loads", overflow)
    error = _refusal(b"[[1]]")
    assert (error.status, error.reason) == (400, "malformed-json")
    assert isinstance(error.__cause__.__cause__, RecursionError)


def test_deep_json_nesting_decodes_or_is_400():
    depth = 100_000
    try:
        kind, _ = _request(b"[" * depth + b"]" * depth)
    except RequestError as error:
        assert (error.status, error.reason) == (400, "malformed-json")
    else:
        assert kind == "json"


@pytest.mark.parametrize("body", ["\ud800abc", "\ud83d\ude00" * 3, "\udfff" * 40])
def test_string_hyperfly_responses_encode_like_text_encoder(body):
    with pytest.raises(DecodeError) as raised:
        decode_response(HYPERFLY_MEDIA_TYPE, body, CodecRegistry([CODEC_A]))
    assert raised.value.code == "header"


def test_string_hyperfly_response_replaces_lone_surrogates():
    body = "hf\x01" + "\ud800" * 16
    assert decode_response(HYPERFLY_MEDIA_TYPE, body, CodecRegistry([CODEC_A])) == ("unknown-codec", "efbfbd" * 5 + "ef")


def test_a_producer_may_reuse_and_resize_its_buffer():
    def stream():
        chunk = bytearray(b"[1")
        yield chunk
        chunk.clear()
        chunk.extend(b"]")
        yield chunk

    assert read_body(stream()) == b"[1]"
    assert _request(stream(), registry=CodecRegistry()) == ("json", [1])


def test_a_producer_may_mutate_its_buffer_between_yields():
    def stream():
        chunk = bytearray(b"[1")
        yield chunk
        chunk[:] = b",2"
        yield chunk
        chunk[:] = b"]"
        yield memoryview(chunk)

    assert read_body(stream()) == b"[1,2]"


def _released_view():
    view = memoryview(b"[1]")
    view.release()
    return view


@pytest.mark.parametrize("body", [lambda: [_released_view()], _released_view])
def test_a_released_buffer_is_unreadable(body):
    for call in (read_body, _request):
        with pytest.raises(RequestError) as raised:
            call(body())
        assert (raised.value.status, raised.value.reason) == (400, "unreadable")
        assert isinstance(raised.value.__cause__, ValueError)


class _Buffer:
    def __init__(self, error):
        self.error = error

    def __buffer__(self, flags):
        raise self.error


@pytest.mark.skipif(sys.version_info < (3, 12), reason="__buffer__ needs 3.12")
def test_a_failing_buffer_protocol_is_unreadable_but_memory_errors_propagate():
    with pytest.raises(RequestError) as raised:
        read_body([_Buffer(RuntimeError("gone"))])
    assert raised.value.status == 400 and isinstance(raised.value.__cause__, RuntimeError)
    with pytest.raises(MemoryError):
        read_body([_Buffer(MemoryError())])


def test_interrupts_and_memory_errors_from_the_stream_propagate():
    for error in (KeyboardInterrupt, MemoryError):
        with pytest.raises(error):
            read_body(Chunks([], fail=error()))


def test_read_body_releases_a_yielded_memoryview_before_the_next_pull():
    def stream():
        buffer = bytearray(b"[1")
        yield memoryview(buffer)
        buffer.clear()
        buffer.extend(b"]")
        yield bytes(buffer)

    assert read_body(stream()) == b"[1]"


def test_read_body_releases_the_crossing_memoryview_before_closing_the_stream():
    cleared = []

    def stream():
        buffer = bytearray(b"[1,2]")
        try:
            yield memoryview(buffer)
        finally:
            buffer.clear()
            cleared.append(True)

    with pytest.raises(RequestError) as raised:
        read_body(stream(), max_bytes=4)
    assert raised.value.status == 413
    assert cleared == [True]


@pytest.mark.parametrize("nested", [False, True])
def test_json_fallback_dumps_bytes_free_models_with_extras_once(monkeypatch, nested):
    from pydantic import ConfigDict

    class Extra(BaseModel):
        model_config = ConfigDict(extra="allow")
        number: int

    class Response(BaseModel):
        children: dict[str, list[Extra]]

    extra = Extra(number=1, metadata={"items": ["text", 2, None]})
    value = Response(children={"entry": [extra]}) if nested else extra
    calls = []
    dump = BaseModel.model_dump

    def counted(self, **kwargs):
        calls.append(kwargs)
        return dump(self, **kwargs)

    monkeypatch.setattr(BaseModel, "model_dump", counted)
    for _ in range(2):
        body, _ = encode_for(negotiate(None, CodecRegistry()), value)
        expected = {"number": 1, "metadata": {"items": ["text", 2, None]}}
        assert json.loads(body) == ({"children": {"entry": [expected]}} if nested else expected)
    assert calls == [{"mode": "json", "by_alias": True}] * 2


def test_json_fallback_publishes_one_complete_class_cache_entry(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    import hyperfly.http as http

    published = threading.Event()
    observed = threading.Event()
    stores = []
    metaclass = type(BaseModel)

    class Meta(metaclass):
        def __setattr__(cls, name, entry):
            if name == http._MODEL_JSON_ATTRIBUTE:
                from pydantic_core import SchemaSerializer
                assert isinstance(entry.serializer, SchemaSerializer)
                stores.append(entry)
                super().__setattr__(name, entry)
                published.set()
                assert observed.wait(5)
            else:
                super().__setattr__(name, entry)

    class Response(BaseModel, metaclass=Meta):
        payload: bytes

    value = Response(payload=b"\xff")
    decision = negotiate(None, CodecRegistry())
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(encode_for, decision, value)
        assert published.wait(5)
        try:
            second = pool.submit(encode_for, decision, value)
            assert json.loads(second.result(timeout=5)[0]) == {"payload": "/w=="}
        finally:
            observed.set()
        assert first.result(timeout=5) == second.result(timeout=5)
    assert stores == [Response.__dict__[http._MODEL_JSON_ATTRIBUTE]]


def test_json_fallback_concurrent_first_encodes():
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from pydantic import ConfigDict

    decision = negotiate(None, CodecRegistry())
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in range(30):
            class Extra(BaseModel):
                model_config = ConfigDict(extra="allow")
                number: int

            class Binary(BaseModel):
                payload: bytes

            barrier = threading.Barrier(8)

            def encode(worker):
                barrier.wait(timeout=5)
                for _ in range(20):
                    value = Extra(number=worker, payload=b"test") if worker % 2 else Binary(payload=b"test")
                    plain = json.loads(encode_for(decision, value)[0])
                    assert plain.pop("payload") == ("test" if worker % 2 else "dGVzdA==")
                    assert plain == ({"number": worker} if worker % 2 else {})

            futures = [pool.submit(encode, worker) for worker in range(8)]
            for future in futures:
                future.result(timeout=10)


@pytest.mark.parametrize("bytes_mode", ["utf8", "base64", "hex"])
def test_json_fallback_preserves_untyped_bytes_key_spelling(bytes_mode):
    from pydantic import ConfigDict

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        data: dict[bytes, bytes]
        tuples: dict[tuple[bytes, int], bytes]
        payload: bytes

    value = Response(data={b"key": b"test"}, tuples={(b"key", 7): b"test"}, payload=b"test")
    expected = value.model_dump(mode="json", by_alias=True)
    expected["payload"] = "dGVzdA=="
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("declared", [False, True])
def test_json_fallback_wraps_non_utf8_bytes_key_failures(declared):
    from pydantic import ConfigDict

    class Extra(BaseModel):
        model_config = ConfigDict(extra="allow")

    class Response(BaseModel):
        data: dict[bytes, bytes]

    value = Response(data={b"\xff": b"test"}) if declared else Extra(data={b"\xff": b"test"})
    with pytest.raises(EncodeError) as raised:
        encode_for(negotiate(None, CodecRegistry()), value)
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, UnicodeDecodeError)


@pytest.mark.parametrize("limited", [False, True])
@pytest.mark.parametrize("failure", ["unicode", "pydantic", "type", "value"])
def test_json_fallback_wraps_serialization_failures(limited, failure):
    from pydantic_core import PydanticSerializationError

    errors = {
        "unicode": UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid byte"),
        "pydantic": PydanticSerializationError("serializer failed"),
        "type": TypeError("serializer failed"),
        "value": ValueError("serializer failed"),
    }

    class Value:
        def model_dump(self, **kwargs):
            raise errors[failure]

    class Limited:
        fingerprint = "a" * 32

        def encode(self, value):
            raise EncodeError("limit", "too large")

    from hyperfly.http import Negotiation

    decision = Negotiation("hyperfly", {}, Limited()) if limited else negotiate(None, CodecRegistry())
    with pytest.raises(EncodeError) as raised:
        encode_for(decision, Value())
    assert raised.value.code == "json"
    assert raised.value.__cause__ is errors[failure]


def test_json_fallback_dumps_bytes_free_any_and_enum_models_once(monkeypatch):
    from typing import Any

    class State(Enum):
        ready = "ready"

    class EnumResponse(BaseModel):
        state: State

    class AnyResponse(BaseModel):
        data: Any

    calls = []
    dump = BaseModel.model_dump

    def counted(self, **kwargs):
        calls.append(kwargs)
        return dump(self, **kwargs)

    monkeypatch.setattr(BaseModel, "model_dump", counted)
    for value in (EnumResponse(state=State.ready), AnyResponse(data={"nested": [7, "text"]})):
        encode_for(negotiate(None, CodecRegistry()), value)
    assert calls == [{"mode": "json", "by_alias": True}] * 2


@pytest.mark.parametrize("payload", [b"test", b"\xfb\xff\xfe\x00"])
def test_json_fallback_declared_wrappers_tuples_and_serialization_alias(payload):
    import base64
    from typing import Annotated
    from pydantic import BeforeValidator, Field, field_serializer

    class Child(BaseModel):
        data: Annotated[bytes, BeforeValidator(lambda value: value)] = Field(
            alias="input", serialization_alias="wire",
        )

    class Response(BaseModel):
        child: Child
        positional: tuple[bytes, int, bytes | None]
        variadic: tuple[bytes, ...]
        default: bytes = payload
        redacted: str

        @field_serializer("redacted", when_used="json")
        def redact(self, value):
            return "REDACTED"

    value = Response(child=Child(input=payload), positional=(payload, 7, None),
                     variadic=(payload, payload), redacted="secret")
    saved = value.__dict__.copy()
    encoded = base64.b64encode(payload).decode("ascii")
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {
        "child": {"wire": encoded}, "positional": [encoded, 7, None],
        "variadic": [encoded, encoded], "default": encoded, "redacted": "REDACTED",
    }
    assert value.__dict__ == saved
    assert "__pydantic_serializer__" not in value.__dict__


def validated_bytes_model(style, mode, position):
    from typing import Annotated
    from pydantic import AfterValidator, BeforeValidator, PlainValidator, WrapValidator, field_validator

    def same(value):
        return value

    def wrap(value, handler):
        return handler(value)

    validator = {"after": AfterValidator, "before": BeforeValidator,
                 "wrap": WrapValidator, "plain": PlainValidator}[mode](wrap if mode == "wrap" else same)
    scalar = Annotated[bytes, validator] if style == "annotated-item" else bytes

    class Child(BaseModel):
        data: scalar

    annotation = {"bytes": scalar, "nullable": scalar | None, "list": list[scalar], "nested": Child}[position]
    if style == "annotated":
        annotation = Annotated[annotation, validator]

    class Response(BaseModel):
        data: annotation

        if style == "decorated":
            validate_data = field_validator("data", mode=mode)(wrap if mode == "wrap" else same)

    return Response, Child


@pytest.mark.parametrize("style", ["decorated", "annotated", "annotated-item"])
@pytest.mark.parametrize("mode", ["after", "before", "wrap", "plain"])
@pytest.mark.parametrize("position", ["bytes", "nullable", "list", "nested"])
@pytest.mark.parametrize("payload", [b"hi", b"\xff", None])
def test_json_fallback_bytes_under_field_validators_round_trip(style, mode, position, payload):
    import base64

    Response, Child = validated_bytes_model(style, mode, position)
    scalar = b"hi" if payload is None else payload
    data = {"bytes": scalar, "nullable": payload, "list": [scalar], "nested": Child(data=scalar)}[position]
    value = Response(data=data)
    codec = compile_model(Response)
    registry = CodecRegistry([codec])
    scalar_ir = {"kind": "bytes"}
    field_ir = {"bytes": scalar_ir, "nullable": scalar_ir, "list": {"kind": "array", "element": scalar_ir},
                "nested": {"kind": "struct", "fields": [{"name": "data", "type": scalar_ir}]}}[position]
    assert codec.ir["fields"][0]["type"] == field_ir
    encoded = base64.b64encode(scalar).decode("ascii")
    expected = {"bytes": encoded, "nullable": None if payload is None else encoded,
                "list": [encoded], "nested": {"data": encoded}}[position]
    body, headers = encode_for(negotiate("application/json", registry), value)
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body) == {"data": expected}
    decoded = {"data": scalar} if position == "nested" else data
    assert decode_response("application/json", body, registry) == ("json", {"data": decoded})
    assert "__pydantic_serializer__" not in value.__dict__


@pytest.mark.parametrize("style,mode,serializer", [
    (style, mode, serializer)
    for style in ("decorated", "annotated")
    for mode in ("after", "before", "wrap", "plain")
    for serializer in ("field-plain", "field-wrap", "plain", "wrap")
    if style == "annotated" or serializer.startswith("field-")
])
@pytest.mark.parametrize("payload", [b"hi", b"\xff"])
def test_json_fallback_bytes_validators_preserve_custom_serializers(style, mode, serializer, payload):
    from typing import Annotated
    from pydantic import ConfigDict, PlainSerializer, WrapSerializer, field_serializer

    Validated, _ = validated_bytes_model(style, mode, "bytes")

    if serializer in ("plain", "wrap"):
        metadata = (PlainSerializer(lambda value: "CUSTOM") if serializer == "plain"
                    else WrapSerializer(lambda value, handler: handler(value)))

        class Response(Validated):
            model_config = ConfigDict(ser_json_bytes="hex")
            data: Annotated[Validated.model_fields["data"].rebuild_annotation(), metadata]
    elif serializer == "field-plain":
        class Response(Validated):
            model_config = ConfigDict(ser_json_bytes="hex")

            @field_serializer("data")
            def serialize(self, value):
                return "CUSTOM"
    else:
        class Response(Validated):
            model_config = ConfigDict(ser_json_bytes="hex")

            @field_serializer("data", mode="wrap")
            def serialize(self, value, handler):
                return handler(value)

    value = Response(data=payload)
    expected = "CUSTOM" if serializer in ("field-plain", "plain") else payload.hex()
    assert value.model_dump(mode="json", by_alias=True) == {"data": expected}
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert json.loads(body) == {"data": expected}


@pytest.mark.parametrize("style", ["decorated", "annotated", "annotated-item"])
@pytest.mark.parametrize("mode", ["after", "before", "wrap", "plain"])
@pytest.mark.parametrize("position", ["bytes", "nullable", "list", "nested"])
@pytest.mark.parametrize("payload", ["text", 7, {"data": "text"}, b"\xff"])
def test_json_fallback_bytes_validators_preserve_unexpected_values(style, mode, position, payload):
    from pydantic import ConfigDict

    Validated, _ = validated_bytes_model(style, mode, position)

    class Response(Validated):
        model_config = ConfigDict(ser_json_bytes="hex")
        sibling: bytes = b"hi"

    value = Response.model_construct(data=payload)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        original = value.model_dump(mode="json", by_alias=True)
        body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    expected = dict(original, sibling="aGk=")
    if isinstance(payload, bytes) and position in ("bytes", "nullable"):
        expected["data"] = "/w=="
    assert json.loads(body) == expected


@pytest.mark.parametrize("declared_sibling", [False, True])
def test_json_fallback_iterable_keeps_json_only_redaction(declared_sibling):
    from typing import Iterable
    from pydantic import field_serializer

    class Response(BaseModel):
        data: Iterable[int]
        secret: str

        @field_serializer("secret", when_used="json")
        def redact(self, value):
            return "REDACTED"

    class BinaryResponse(Response):
        payload: bytes

    model = BinaryResponse if declared_sibling else Response
    kwargs = {"payload": b"test"} if declared_sibling else {}
    expected = model(data=iter([1, 2]), secret="secret", **kwargs).model_dump(mode="json", by_alias=True)
    if declared_sibling:
        expected["payload"] = "dGVzdA=="
    value = model(data=iter([1, 2]), secret="secret", **kwargs)
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected
    assert expected["secret"] == "REDACTED"


@pytest.mark.parametrize("declared_sibling", [False, True])
def test_json_fallback_computed_fields_follow_json_mode(declared_sibling):
    from typing import Any
    from pydantic import computed_field

    class Response(BaseModel):
        @computed_field
        @property
        def computed(self) -> Any:
            return b"test"

        @computed_field
        @property
        def typed_computed(self) -> bytes:
            return b"test"

    class BinaryResponse(Response):
        payload: bytes = b"test"

    value = BinaryResponse() if declared_sibling else Response()
    expected = value.model_dump(mode="json", by_alias=True)
    if declared_sibling:
        expected["payload"] = "dGVzdA=="
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
def test_json_fallback_untyped_positions_follow_json_mode(bytes_mode):
    from dataclasses import dataclass
    from datetime import timedelta
    from typing import Any, Literal
    from pydantic import ConfigDict

    @dataclass
    class Data:
        data: bytes

    class Binary(Enum):
        data = Data(b"test")

    class Child(BaseModel):
        data: bytes

    class Response(BaseModel):
        model_config = ConfigDict(extra="allow", ser_json_bytes=bytes_mode, ser_json_timedelta="float")
        data: Any
        mapping: dict[timedelta, bytes]
        enum: Binary
        literal: Literal[b"test"]
        unique: set[bytes]
        frozen: frozenset[bytes]
        children: list[Child]
        untyped_children: dict[str, Child]
        payload: bytes

    value = Response(data={"mixed": {b"test", "unchanged", 7}, "dataclass": Data(b"test"),
                           "collisions": {b"key": b"first", "key": b"last"}},
                     mapping={timedelta(seconds=90): b"test"}, enum=Binary.data, literal=b"test",
                     unique={b"test", b"second"}, frozen=frozenset({b"test", b"second"}),
                     children=[Child(data=b"test")], untyped_children={"child": Child(data=b"test")},
                     payload=b"test", extra={"data": b"test"})
    expected = value.model_dump(mode="json", by_alias=True)
    expected["payload"] = "dGVzdA=="
    expected["children"] = [{"data": "dGVzdA=="}]
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


def test_json_fallback_excluded_any_is_not_traversed():
    from typing import Any
    from pydantic import Field

    class Response(BaseModel):
        hidden: Any = Field(exclude=True)
        payload: bytes

    value = Response(hidden=range(1_000_000), payload=b"test")
    expected = value.model_dump(mode="json", by_alias=True)
    expected["payload"] = "dGVzdA=="
    decision = negotiate(None, CodecRegistry())
    encode_for(decision, value)
    start = time.perf_counter()
    for _ in range(10):
        assert json.loads(encode_for(decision, value)[0]) == expected
    assert time.perf_counter() - start < 0.2


@pytest.mark.parametrize("placement", ["any", "extra", "dict", "plain"])
def test_json_fallback_untyped_non_utf8_errors_are_not_retried(placement):
    from typing import Any
    from pydantic import ConfigDict, field_serializer

    calls = []

    class Response(BaseModel):
        model_config = ConfigDict(extra="allow")
        payload: bytes = b"test"
        secret: str = "secret"
        data: Any = None
        mapping: dict[str, bytes] = {}

        @field_serializer("secret", when_used="json")
        def redact(self, value):
            calls.append(value)
            return "REDACTED"

    value = {
        "any": Response(data=b"\xff"), "extra": Response(extra=b"\xff"),
        "dict": Response(mapping={"data": b"\xff"}), "plain": {"data": b"\xff"},
    }[placement]
    if placement == "plain":
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {"data": "/w=="}
        assert calls == []
        return
    with pytest.raises(EncodeError) as raised:
        encode_for(negotiate(None, CodecRegistry()), value)
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, UnicodeDecodeError)
    assert len(calls) <= 1


@pytest.mark.parametrize("nested", [False, True])
def test_json_fallback_non_model_values_follow_pydantic_json_mode(nested):
    from dataclasses import dataclass
    from pydantic_core import to_jsonable_python

    @dataclass
    class Data:
        data: bytes

    value = Data(b"test")
    expected = to_jsonable_python(value)
    if nested:
        value = {"data": value, "items": [b"test", bytearray(b"second")]}
        expected = {"data": expected, "items": ["dGVzdA==", "c2Vjb25k"]}
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("operation", ["reorder", "filter", "duplicate"])
@pytest.mark.parametrize("when_used", ["json", "always"])
@pytest.mark.parametrize("bytes_mode,payload", [("utf8", b"ONE"), ("hex", b"\xfb\xff"), ("base64", b"\xfb\xff")])
def test_json_fallback_wrap_field_serializer_owns_rows(operation, when_used, bytes_mode, payload):
    from pydantic import ConfigDict, field_serializer

    class Row(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        name: str
        data: bytes

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        rows: list[Row]
        sibling: bytes = b"test"

        @field_serializer("rows", mode="wrap", when_used=when_used)
        def serialize_rows(self, rows, handler):
            result = handler(rows)
            return {"reorder": result[::-1], "filter": result[1:], "duplicate": [result[1], result[1]]}[operation]

    value = Response(rows=[Row(name="first", data=payload), Row(name="second", data=b"TWO")])
    expected = value.model_dump(mode="json", by_alias=True)
    expected["sibling"] = "dGVzdA=="
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("serializer", ["field", "model", "plain", "wrap"])
@pytest.mark.parametrize("when_used", ["json", "always"])
@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("payload", [b"test", b"\xfb\xff"])
def test_json_fallback_custom_serializer_uses_original_bytes_config(serializer, when_used, bytes_mode, payload):
    from typing import Annotated
    from pydantic import ConfigDict, PlainSerializer, WrapSerializer, field_serializer, model_serializer

    class Row(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        data: bytes

    if serializer == "model":
        class CustomRow(Row):
            @model_serializer(mode="wrap", when_used=when_used)
            def serialize(self, handler):
                return handler(self)
        annotation = CustomRow
    elif serializer == "plain":
        annotation = Annotated[Row, PlainSerializer(lambda row: {"data": row.data}, when_used=when_used)]
    elif serializer == "wrap":
        annotation = Annotated[Row, WrapSerializer(lambda row, handler: handler(row), when_used=when_used)]
    else:
        annotation = Row

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        row: annotation
        sibling: bytes = b"test"

    if serializer == "field":
        class FieldResponse(Response):
            @field_serializer("row", mode="wrap", when_used=when_used)
            def serialize_row(self, row, handler):
                return handler(row)
        model = FieldResponse
    else:
        model = Response

    value = model(row={"data": payload})
    try:
        expected = value.model_dump(mode="json", by_alias=True)
    except Exception:
        with pytest.raises(EncodeError) as raised:
            encode_for(negotiate(None, CodecRegistry()), value)
        assert raised.value.code == "json"
    else:
        expected["sibling"] = "dGVzdA=="
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


@pytest.mark.parametrize("collision", ["extra", "field", "computed"])
@pytest.mark.parametrize("bytes_first", [False, True])
def test_json_fallback_preserves_alias_collision_winner(collision, bytes_first):
    from pydantic import ConfigDict, Field, computed_field, create_model

    class Extra(BaseModel):
        model_config = ConfigDict(extra="allow", ser_json_bytes="hex")

    fields = {"payload": (bytes, Field(serialization_alias="same")), "sibling": (bytes, b"test")}
    if collision == "field":
        other = {"public": (str, Field("public", serialization_alias="same"))}
        fields = {**fields, **other} if bytes_first else {**other, **fields}
    model = create_model("Response", __base__=Extra, **fields)
    if collision == "computed":
        class ComputedResponse(model):
            @computed_field(alias="same")
            @property
            def public(self) -> str:
                return "public"
        model = ComputedResponse
    value = model(payload=b"ab", **({"same": "public"} if collision == "extra" else {}))
    expected = value.model_dump(mode="json", by_alias=True)
    expected["sibling"] = "dGVzdA=="
    if collision == "field" and not bytes_first:
        # Pydantic chooses the last field; its declared bytes serializer applies.
        expected["same"] = "YWI="
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == expected


def test_json_fallback_extra_collision_does_not_overlay_nested_model():
    from pydantic import ConfigDict, Field

    class Row(BaseModel):
        data: bytes

    class Response(BaseModel):
        model_config = ConfigDict(extra="allow")
        row: Row = Field(serialization_alias="same")

    value = Response(row=Row(data=b"first"), same={"data": "public"})
    assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == value.model_dump(mode="json", by_alias=True)


@pytest.mark.parametrize("key,expected", [
    (None, "null"), (True, "true"), (False, "false"), (7, "7"), (1.5, "1.5"),
    (math.nan, "NaN"), (math.inf, "Infinity"), (-math.inf, "-Infinity"),
])
def test_json_fallback_plain_dict_keys_keep_original_json_spelling(key, expected):
    class Key(Enum):
        value = key

    for item in (key, Key.value):
        value = {"nested": [{item: "value"}], "payload": b"test"}
        assert json.loads(encode_for(negotiate(None, CodecRegistry()), value)[0]) == {
            "nested": [{expected: "value"}], "payload": "dGVzdA==",
        }


def test_json_fallback_plain_tuple_key_keeps_original_json_rejection():
    with pytest.raises(EncodeError) as raised:
        encode_for(negotiate(None, CodecRegistry()), {(1, 2): "value"})
    assert raised.value.code == "json"
    assert isinstance(raised.value.__cause__, TypeError)


@pytest.mark.parametrize("bytes_mode", ["utf8", "hex", "base64"])
@pytest.mark.parametrize("aliases", ["chain", "swap"])
@pytest.mark.parametrize("override", [
    "default", "by_alias_false", "exclude_payload", "include_label",
    "exclude_label", "include_payload", "reorder", "replace",
])
def test_json_fallback_dump_overrides_match_main_output(aliases, override, bytes_mode):
    from pydantic import ConfigDict, Field

    class Response(BaseModel):
        model_config = ConfigDict(ser_json_bytes=bytes_mode)
        payload: bytes = Field(serialization_alias="label")
        label: str = Field(serialization_alias="caption" if aliases == "chain" else "payload")

        def model_dump(self, **kwargs):
            if override == "by_alias_false":
                kwargs["by_alias"] = False
            elif override.startswith("exclude_"):
                kwargs["exclude"] = {override.removeprefix("exclude_")}
            elif override.startswith("include_"):
                kwargs["include"] = {override.removeprefix("include_")}
            result = super().model_dump(**kwargs)
            if override == "reorder":
                return dict(reversed(list(result.items())))
            if override == "replace":
                return {**result, "label": "dump owns this"}
            return result

    value = Response(payload=b"hi", label="keep me")
    caption = "caption" if aliases == "chain" else "payload"
    expected = {
        "default": {"label": "aGk=", caption: "keep me"},
        "by_alias_false": {"payload": "aGk=", "label": "keep me"},
        "exclude_payload": {caption: "keep me"},
        "include_label": {caption: "keep me"},
        "exclude_label": {"label": "aGk="},
        "include_payload": {"label": "aGk="},
        "reorder": {caption: "keep me", "label": "aGk="},
        "replace": {"label": "dump owns this", caption: "keep me"},
    }[override]
    original = value.model_dump(mode="json", by_alias=True)
    # Preserve origin/main's whole dump, normalizing only the declared bytes
    # representation. The base64 config compares the whole body byte for byte.
    original_bytes = {"utf8": "hi", "hex": "6869", "base64": "aGk="}[bytes_mode]
    assert original == {key: original_bytes if item == "aGk=" else item for key, item in expected.items()}
    body, _ = encode_for(negotiate(None, CodecRegistry()), value)
    assert body == json.dumps(expected, separators=(",", ":")).encode()
    assert value.model_dump(mode="json", by_alias=True) == original
