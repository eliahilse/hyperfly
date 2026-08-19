from typing import Literal, Optional

import pytest
from pydantic import BaseModel, Field

from conftest import load
from hyperfly import UnsupportedSchemaError
from hyperfly.pydantic import compile, to_ir


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
