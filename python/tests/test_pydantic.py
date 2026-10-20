from typing import Literal, Optional

import pytest
from pydantic import BaseModel, Field, ValidationError, field_validator

from conftest import load
from hyperfly import Codec, CodecRegistry, DecodeError, EncodeError, HyperflyError, UnsupportedSchemaError, compile_ir
from hyperfly.pydantic import ModelCodec, compile, to_ir


class Candle(BaseModel):
    t: int = Field(ge=0)
    o: float
    h: float
    l: float
    c: float
    v: float


class CandleResponse(BaseModel):
    route: Literal["candles"]
    candles: list[Candle]
    cursor: Optional[str]


def test_to_ir_matches_reference_fingerprint():
    ir = to_ir(CandleResponse)
    assert ir["fields"][0] == {"name": "route", "type": {"kind": "literal", "value": "candles"}}
    assert ir["fields"][2] == {"name": "cursor", "type": {"kind": "string"}, "nullable": True}

    cases = {c["name"]: c for c in load("fingerprints.json")["cases"]}
    reference = cases["candles-response@row"]["ir"]
    assert ir["fields"][1] == reference["fields"][1]


def test_roundtrip_and_validate():
    codec = compile(CandleResponse, plan="columnar")
    payload = {
        "route": "candles",
        "candles": [
            {"t": 1700000000000, "o": 1.1, "h": 2.2, "l": 0.9, "c": 1.7, "v": 1234.5},
            {"t": 1700000300000, "o": 1.7, "h": 1.9, "l": 1.2, "c": 1.4, "v": 987.6},
        ],
        "cursor": None,
    }
    assert codec.decode(codec.encode(payload)) == payload

    model = CandleResponse.model_validate(payload)
    assert codec.decode(codec.encode(model)) == payload

    validating = compile(CandleResponse, validate=True)
    decoded = validating.decode(validating.encode(payload))
    assert isinstance(decoded, CandleResponse)


def test_unsupported_fails_loudly():
    class Bad(BaseModel):
        mapping: dict[str, int]

    with pytest.raises(UnsupportedSchemaError) as err:
        to_ir(Bad)
    assert err.value.path == "$.mapping"


def test_cross_language_fingerprint_for_shared_schema():
    class Shared(BaseModel):
        pct: int = Field(ge=0, le=100)

    ir = to_ir(Shared)
    assert ir == {"kind": "struct", "fields": [{"name": "pct", "type": {"kind": "int", "min": 0, "max": 100}}]}


@pytest.mark.parametrize("validate", [False, True])
@pytest.mark.parametrize("factory", [compile, ModelCodec])
def test_profiled_columnar_roundtrip(validate, factory):
    class Row(BaseModel):
        status: str

    class Response(BaseModel):
        rows: list[Row]

    profile = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["online", "offline"]}]}}
    codec = factory(Response, plan="columnar", profile=profile, pack=False, validate=validate)
    reference = compile_ir(to_ir(Response), plan="columnar", profile=profile, pack=False)
    assert codec.plan == "columnar"
    assert codec.profile == profile
    assert codec.ir == reference.ir
    assert codec.fingerprint == reference.fingerprint
    assert codec.artifact == reference.artifact
    value = {"rows": [{"status": "online"}, {"status": "offline"}, {"status": "unknown"}]}
    model = Response.model_validate(value)
    expected = model if validate else value
    assert codec.decode(codec.encode(model)) == expected
    assert codec.decode_body(codec.encode_body(value)) == expected
    assert codec.encode(value) == reference.encode(value)
    codec.profile["shared"]["columns"][0]["dict"][0] = "changed"
    codec.ir["fields"].clear()
    profile["shared"]["columns"][0]["dict"][0] = "changed"
    assert codec.decode(codec.encode(model)) == expected


@pytest.mark.parametrize("attribute", ["fingerprint", "artifact", "plan", "ir", "profile"])
def test_model_codec_metadata_is_read_only(attribute):
    codec = compile(CandleResponse)
    metadata = getattr(codec, attribute)
    with pytest.raises(AttributeError):
        setattr(codec, attribute, None)
    assert getattr(codec, attribute) == metadata


class _Positive(BaseModel):
    n: int

    @field_validator("n")
    @classmethod
    def _positive(cls, value: int) -> int:
        if value < 0:
            raise ValueError("negative")
        return value


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("validate", [False, True])
def test_model_codec_constructor_matches_compile(plan, validate):
    direct = ModelCodec(_Positive, plan=plan, validate=validate, pack=False)
    compiled = compile(_Positive, plan=plan, validate=validate, pack=False)
    assert direct.fingerprint == compiled.fingerprint
    assert direct.artifact == compiled.artifact
    assert direct.model is compiled.model is _Positive
    assert direct.validate is compiled.validate is validate
    expected = _Positive(n=1) if validate else {"n": 1}
    for encode, decode in (("encode", "decode"), ("encode_body", "decode_body")):
        data = getattr(direct, encode)({"n": 1})
        assert data == getattr(compiled, encode)({"n": 1})
        assert getattr(direct, decode)(data) == getattr(compiled, decode)(data) == expected
    with pytest.raises(TypeError):
        ModelCodec(_Positive, plan)


@pytest.mark.parametrize("factory", [compile, ModelCodec])
@pytest.mark.parametrize("options,message", [
    ({"plan": "invalid", "validate": None}, "plan: must be row or columnar"),
    ({"pack": True}, "pack: must be False or a mapping"),
    ({"validate": None}, "validate: must be a boolean"),
])
def test_model_options_are_checked_before_unsupported_schema(factory, options, message):
    class Unsupported(BaseModel):
        mapping: dict[str, int]

    with pytest.raises(HyperflyError) as err:
        factory(Unsupported, **options)
    assert (err.value.code, str(err.value)) == ("options", message)


@pytest.mark.parametrize("method", ["encode", "encode_body"])
@pytest.mark.parametrize("value", [{"n": -1}, {"m": 1}, "x"])
def test_failed_validation_on_encode_is_an_encode_error(method, value):
    codec = compile(_Positive, validate=True)
    with pytest.raises(EncodeError) as raised:
        getattr(codec, method)(value)
    assert raised.value.code == "validation"
    assert isinstance(raised.value, HyperflyError)
    assert isinstance(raised.value.__cause__, ValidationError)


@pytest.mark.parametrize("method", ["decode", "decode_body"])
def test_failed_validation_on_decode_is_a_decode_error(method):
    codec = compile(_Positive, validate=True)
    loose = compile_ir(codec.ir)
    data = loose.encode({"n": -1}) if method == "decode" else loose.encode_body({"n": -1})
    with pytest.raises(DecodeError) as raised:
        getattr(codec, method)(data)
    assert raised.value.code == "validation"
    assert isinstance(raised.value.__cause__, ValidationError)
    assert compile(_Positive).decode(loose.encode({"n": -1})) == {"n": -1}


@pytest.mark.parametrize("attribute", ["model", "validate"])
def test_model_codec_settings_are_read_only(attribute):
    codec = compile(_Positive, validate=True)
    assert codec.model is _Positive
    assert codec.validate is True
    with pytest.raises(AttributeError):
        setattr(codec, attribute, None)


@pytest.mark.parametrize("method", ["encode", "encode_body", "decode", "decode_body"])
def test_model_codec_validates_once_per_operation(monkeypatch, method):
    codec = compile(_Positive, validate=True)
    assert isinstance(codec, ModelCodec)
    assert isinstance(codec, Codec)
    registry = CodecRegistry([codec])
    assert registry.get(codec.fingerprint) is codec
    validate = _Positive.model_validate
    calls = []

    def counted(value):
        calls.append(value)
        return validate(value)

    plain = compile_ir(codec.ir)
    value = {"n": 1}
    data = plain.encode(value) if method == "decode" else plain.encode_body(value)
    monkeypatch.setattr(_Positive, "model_validate", counted)
    result = getattr(codec, method)(data if method.startswith("decode") else value)
    assert len(calls) == 1
    if method.startswith("decode"):
        assert result == _Positive(n=1)
    else:
        assert result == (plain.encode(value) if method == "encode" else plain.encode_body(value))


@pytest.mark.parametrize("validate", [False, True])
def test_model_codec_http_roundtrip_and_json_fallback(validate):
    from hyperfly.http import decode_request, decode_response, encode_for, negotiate

    codec = compile(_Positive, validate=validate)
    registry = CodecRegistry([codec])
    model = _Positive(n=1)
    expected = model if validate else {"n": 1}
    decision = negotiate(codec.fingerprint, registry)
    assert decision.codec is codec
    body, headers = encode_for(decision, model)
    content_type = headers["Content-Type"]
    assert decode_response(content_type, body, registry) == ("hyperfly", expected)
    assert decode_request(content_type, codec.fingerprint, body, registry) == ("hyperfly", expected)
    body, headers = encode_for(negotiate(None, registry), model)
    assert body == b'{"n":1}'
    assert decode_response(headers["Content-Type"], body, registry) == ("json", {"n": 1})
    assert decode_request(headers["Content-Type"], None, body, registry) == ("json", {"n": 1})


@pytest.mark.parametrize("validate", [False, True])
def test_model_codec_http_encoder_limit_fallback(validate):
    from hyperfly import Limits
    from hyperfly.http import encode_for, negotiate

    codec = compile(_Positive, validate=validate, limits=Limits(max_depth=0))
    failures = []
    body, headers = encode_for(
        negotiate(codec.fingerprint, CodecRegistry([codec])), _Positive(n=1),
        on_fallback=lambda reason, error: failures.append((reason, error.code)),
    )
    assert failures == [("encoder-limit", "depth")]
    assert body == b'{"n":1}'
    assert headers["Content-Type"] == "application/json"
