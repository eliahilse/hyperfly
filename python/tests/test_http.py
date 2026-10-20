import json
import math
import tracemalloc
from enum import Enum, IntEnum

import pytest
from conftest import load
from pydantic import BaseModel

from hyperfly import CodecRegistry, compile_ir
from hyperfly.http import (
    HYPERFLY_MEDIA_TYPE,
    accept_header,
    decode_response,
    encode_for,
    negotiate,
    parse_accept,
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


def test_every_response_varies_so_caches_cannot_cross_serve():
    registry = CodecRegistry([CODEC_A])
    for accept in (accept_header([CODEC_A.fingerprint]), None):
        assert negotiate(accept, registry).headers["Vary"] == "Hyperfly-Accept"


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
    assert body == b'{"color":"red","levels":[3,0.5],"red":1,"3":2,"Infinity":3}'


def test_json_fallback_rejects_circular_values():
    circular: list = []
    circular.append(circular)
    with pytest.raises(ValueError):
        encode_for(negotiate(None, CodecRegistry()), circular)


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
    with pytest.raises(json.JSONDecodeError):
        decode_response("application/json", body, CodecRegistry())


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
