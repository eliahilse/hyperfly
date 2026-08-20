import pytest

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

IR = {"kind": "struct", "fields": [{"name": "id", "type": {"kind": "string"}}]}
IR_B = {"kind": "struct", "fields": [{"name": "id", "type": {"kind": "string"}}, {"name": "n", "type": {"kind": "int"}}]}
CODEC_A = compile_ir(IR)
CODEC_B = compile_ir(IR_B)
VALUE = {"id": "abc"}


def test_parse_accept_keeps_order_drops_junk_and_duplicates():
    a = "a" * 32
    b = "b" * 32
    assert parse_accept(f"{a.upper()}, nope, {a}, {b}") == [a, b]
    assert parse_accept(None) == []
    assert parse_accept("") == []


def test_parse_accept_is_bounded_against_a_hostile_header():
    flood = ",".join(format(i, "032x") for i in range(5000))
    assert len(parse_accept(flood)) <= 32


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
