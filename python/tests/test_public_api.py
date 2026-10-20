import inspect

import pytest

import hyperfly
import hyperfly.http
import hyperfly.pydantic
import hyperfly.registry


PUBLIC_MODULES = (hyperfly, hyperfly.http, hyperfly.pydantic, hyperfly.registry)


@pytest.mark.parametrize("module", PUBLIC_MODULES)
def test_exports_exist_and_have_docstrings(module):
    assert inspect.getdoc(module)
    assert len(module.__all__) == len(set(module.__all__))
    for name in module.__all__:
        value = getattr(module, name)
        if inspect.isclass(value) or inspect.isfunction(value):
            assert inspect.getdoc(value), f"{module.__name__}.{name}"
        if inspect.isclass(value):
            for member_name, member in inspect.getmembers(value):
                if member_name.startswith("_"):
                    continue
                if isinstance(member, property) or inspect.isroutine(member):
                    assert inspect.getdoc(member), f"{module.__name__}.{name}.{member_name}"


def test_submodules_export_only_their_public_api():
    assert set(hyperfly.http.__all__) == {
        "HYPERFLY_MEDIA_TYPE", "ACCEPT_HEADER", "CODEC_HEADER", "OFFER_HEADER",
        "WELL_KNOWN_PREFIX", "DEFAULT_MAX_BODY_BYTES", "FallbackReason", "Negotiation",
        "ArtifactResponse", "DecodedRequest", "RequestError", "parse_accept", "negotiate",
        "encode_for", "serve_artifact", "accept_header", "decode_response", "read_body", "decode_request",
    }
    assert set(hyperfly.pydantic.__all__) == {"ModelCodec", "compile", "to_ir"}
    assert hyperfly.registry.__all__ == ["CodecRegistry"]
    assert "ModelCodec" not in hyperfly.__all__
    assert {"PackHooks", "validate_profile"} <= set(hyperfly.__all__)
    assert "DEFAULT_LIMITS" in hyperfly.__doc__
    assert "FallbackReason" in hyperfly.http.__doc__


def test_public_profile_validation_matches_compilation():
    ir = {"kind": "array", "element": {
        "kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}],
    }}
    valid = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["online"]}]}}
    assert hyperfly.validate_profile(ir, valid) is None
    malformed = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["online", "online"]}]}}
    errors = []
    for validate in (
        lambda: hyperfly.validate_profile(ir, malformed),
        lambda: hyperfly.compile_ir(ir, plan="columnar", profile=malformed),
    ):
        with pytest.raises(hyperfly.HyperflyError) as err:
            validate()
        errors.append((err.value.code, str(err.value)))
    assert errors[0] == errors[1] == ("ir", "profile: leaf 0: duplicate entry gives one value two codes")


def test_public_profile_validation_checks_ir_first():
    with pytest.raises(hyperfly.HyperflyError) as err:
        hyperfly.validate_profile(None, None)
    assert (err.value.code, str(err.value)) == ("ir", "$: IR node must be an object")


@pytest.mark.parametrize("factory", [bytes, bytearray, memoryview])
@pytest.mark.parametrize("envelope", [False, True])
def test_generic_codec_accepts_bytes_like_input(factory, envelope):
    codec = hyperfly.Codec[bool]({"kind": "bool"})
    encode = codec.encode if envelope else codec.encode_body
    decode = codec.decode if envelope else codec.decode_body
    assert decode(factory(encode(True))) is True


def test_codec_envelope_dispatches_through_public_body_methods():
    class InvertedCodec(hyperfly.Codec[bool]):
        def encode_body(self, value: bool) -> bytes:
            return super().encode_body(not value)

        def decode_body(self, data: bytes | bytearray | memoryview) -> bool:
            return not super().decode_body(data)

    codec = InvertedCodec({"kind": "bool"})
    plain = hyperfly.compile_ir(codec.ir)
    assert codec.encode(True) == plain.encode(False)
    assert codec.decode(plain.encode(False)) is True


@pytest.mark.parametrize("corruption,code,message", [
    ("short", "header", "shorter than envelope header"),
    ("magic", "header", "bad magic"),
    ("version", "header", "unsupported wire major 255"),
    ("fingerprint", "fingerprint", None),
])
def test_codec_checks_envelope_before_dispatching_to_body(corruption, code, message):
    calls = []

    class TrackingCodec(hyperfly.Codec[bool]):
        def decode_body(self, data: bytes | bytearray | memoryview) -> bool:
            calls.append(data)
            return super().decode_body(data)

    codec = TrackingCodec({"kind": "bool"})
    data = bytearray(codec.encode(True))
    if corruption == "short":
        data = data[:2]
    elif corruption == "magic":
        data[:3] = b"xx\xff"
        data[3] ^= 1
    elif corruption == "version":
        data[2] = 255
        data[3] ^= 1
    else:
        data[3] ^= 1
    data[-1] = 255
    with pytest.raises(hyperfly.DecodeError) as raised:
        codec.decode(data)
    assert raised.value.code == code
    if message is not None:
        assert str(raised.value) == message
    assert calls == []
    assert codec.decode(codec.encode(True)) is True
    assert calls == [b"\x01"]
