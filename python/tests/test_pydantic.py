from copy import deepcopy
from enum import Enum
from math import ceil, floor
from typing import Annotated, Generic, Literal, Optional, TypeVar, get_args, get_origin

import pytest
from annotated_types import Ge, GroupedMetadata, Gt, Interval, Le, Lt
from pydantic import (
    AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, PlainValidator, ValidationError,
    WrapValidator, confloat, conint, constr, create_model, field_validator, model_validator,
)
from pydantic_core import SchemaError, core_schema
from pydantic.fields import FieldInfo

from conftest import load, pydantic_version, serializer_warnings, warning_details
from hyperfly import (
    INT_MAX, INT_MIN, Codec, CodecRegistry, DecodeError, EncodeError, HyperflyError,
    UnsupportedSchemaError, compile_ir,
)
from hyperfly.pydantic import ModelCodec, compile, to_ir
from hyperfly.pydantic import _same_schema, _SchemaMismatch


PYDANTIC_VERSION = pydantic_version()


class _EqualFloat(float):
    def __eq__(self, other):
        return True


def _assert_integer_leaf_matches_model_output(model):
    definitions = {}

    def resolve(schema):
        while schema["type"] in ("definitions", "definition-ref"):
            if schema["type"] == "definitions":
                definitions.update((item["ref"], item) for item in schema["definitions"])
                schema = schema["schema"]
            else:
                schema = definitions[schema["schema_ref"]]
        return schema

    schema = resolve(model.__pydantic_core_schema__)
    schema = resolve(schema["schema"]["fields"]["x"]["schema"])
    while schema["type"] in ("list", "nullable", "function-before", "chain", "default"):
        if schema["type"] == "list":
            schema = schema["items_schema"]
        elif schema["type"] == "chain":
            schema = schema["steps"][-1]
        else:
            schema = schema["schema"]
        schema = resolve(schema)
    expected = {"kind": "int"}
    if schema["type"] == "int":
        lower, upper = [INT_MIN], [INT_MAX]
        if "ge" in schema:
            lower.append(ceil(schema["ge"]))
        if "gt" in schema:
            lower.append(floor(schema["gt"]) + 1)
        if "le" in schema:
            upper.append(floor(schema["le"]))
        if "lt" in schema:
            upper.append(ceil(schema["lt"]) - 1)
        if max(lower) != INT_MIN:
            expected["min"] = max(lower)
        if min(upper) != INT_MAX:
            expected["max"] = min(upper)
    actual = to_ir(model)["fields"][0]["type"]
    while actual["kind"] in ("array", "nullable"):
        actual = actual["element"] if actual["kind"] == "array" else actual["inner"]
    assert actual == expected


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


_SIMPLE_BOUND_SHAPES = [
    *(f"{source}-{key}" for source in ("annotated", "field", "annotated-field", "conint")
      for key in ("ge", "gt", "le", "lt")),
    "interval-closed", "interval-open", "field-range", "conint-range",
]
_SIMPLE_BOUND_VALUES = [-1000, -100, -10, -1, 0, 1, 2, 5, 10, 100, 1000.0]


def _simple_bound_case(shape, bound):
    source, key = shape.rsplit("-", 1)
    if key in ("closed", "range"):
        constraints = {"ge": bound, "le": bound + 10}
    elif key == "open":
        constraints = {"gt": bound, "lt": bound + 10}
    else:
        constraints = {key: bound}
    node = {"kind": "int"}
    if "ge" in constraints:
        node["min"] = ceil(constraints["ge"])
    if "gt" in constraints:
        node["min"] = floor(constraints["gt"]) + 1
    if "le" in constraints:
        node["max"] = floor(constraints["le"])
    if "lt" in constraints:
        node["max"] = ceil(constraints["lt"]) - 1
    if source == "conint":
        return conint(**constraints), ..., node
    if source == "field":
        return int, Field(**constraints), node
    if source == "annotated-field":
        metadata = Field(**constraints)
    elif source == "interval":
        metadata = Interval(**constraints)
    else:
        metadata = {"ge": Ge, "gt": Gt, "le": Le, "lt": Lt}[key](bound)
    return Annotated[int, metadata], ..., node


@pytest.mark.parametrize("shape", _SIMPLE_BOUND_SHAPES)
@pytest.mark.parametrize("bound", _SIMPLE_BOUND_VALUES)
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_simple_bound_shapes_keep_reference_artifacts(shape, bound, plan):
    annotation, default, node = _simple_bound_case(shape, bound)
    model = create_model("SimpleBound", x=(annotation, default))
    reference = compile_ir({"kind": "struct", "fields": [{"name": "x", "type": node}]}, plan=plan)
    codec = compile(model, plan=plan)
    assert codec.ir == reference.ir
    assert codec.artifact == reference.artifact
    assert codec.fingerprint == reference.fingerprint


@pytest.mark.parametrize("shape", _SIMPLE_BOUND_SHAPES)
@pytest.mark.parametrize("nullable", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_unvalidated_scalar_defaults_keep_reference_artifacts(shape, nullable, plan):
    annotation, default, node = _simple_bound_case(shape, 10)
    if "min" in node:
        invalid = node["min"] - 1
    else:
        invalid = node["max"] + 1
    if default is ...:
        default = invalid
    else:
        default = FieldInfo.merge_field_infos(default, Field(default=invalid))
    if nullable:
        if get_origin(annotation) is Annotated:
            base, *metadata = get_args(annotation)
            annotation = Annotated[(Optional[base], *metadata)]
        else:
            annotation = Optional[annotation]
    model = create_model("DefaultBound", x=(annotation, default))
    field = {"name": "x", "type": node}
    if nullable:
        field["nullable"] = True
    reference = compile_ir({"kind": "struct", "fields": [field]}, plan=plan)
    codec = compile(model, plan=plan)
    assert codec.ir == reference.ir
    assert codec.artifact == reference.artifact
    assert codec.fingerprint == reference.fingerprint
    assert model().x == invalid
    for encode in (codec.encode, codec.encode_body):
        with pytest.raises(EncodeError) as error:
            encode(model())
        assert error.value.code == "range"


class _Tag(str, Enum):
    A = "a"
    B = "b"


class _Nested(BaseModel):
    n: int


class _Bounds(GroupedMetadata):
    def __iter__(self):
        yield Interval(ge=0, le=10)
        yield Gt(1)
        yield Lt(9)


class _RepeatedBounds(GroupedMetadata):
    def __iter__(self):
        yield Ge(10)
        yield Interval(ge=0, gt=-1, le=0, lt=11)
        yield Le(10)


class _GeSubclass(Ge):
    pass


class _NestedBounds(GroupedMetadata):
    def __iter__(self):
        yield _RepeatedBounds()


class _CustomInterval(Interval):
    def __iter__(self):
        yield Ge(2)
        yield Le(8)


class _FieldBounds(GroupedMetadata):
    def __iter__(self):
        yield Field(ge=2, le=8)


class _IntChain:
    def __get_pydantic_core_schema__(self, source, handler):
        return core_schema.chain_schema([handler(source), core_schema.int_schema(ge=2, le=8)])


def _shift(value):
    if type(value) is not int:
        raise ValueError("expected an integer")
    return value - 100


class _ShiftChain:
    def __get_pydantic_core_schema__(self, source, handler):
        return core_schema.chain_schema([handler(source), core_schema.no_info_plain_validator_function(_shift)])


class _LastIntChain:
    def __get_pydantic_core_schema__(self, source, handler):
        return core_schema.chain_schema([
            handler(source), core_schema.no_info_plain_validator_function(_shift),
            core_schema.int_schema(ge=-100, le=-80),
        ])


class _ReferencedInt:
    @classmethod
    def __get_pydantic_core_schema__(cls, source, handler):
        return core_schema.int_schema(ge=10, ref="BoundedInt")


class _RefChain:
    def __get_pydantic_core_schema__(self, source, handler):
        return core_schema.chain_schema([
            handler.generate_schema(_ReferencedInt), handler.generate_schema(_ReferencedInt),
        ])


def _identity(value):
    return value


class _WireName(str):
    pass


@pytest.mark.parametrize("plan,fingerprint", [
    ("row", "e6bae6502104cca8f16363f49fb9411e"),
    ("columnar", "d8e8621a26bcafab2f3d2a2e7e1b3e1a"),
])
def test_field_level_grouped_bounds_change_schema_and_fingerprint(plan, fingerprint):
    class Constrained(BaseModel):
        x: Annotated[int, _Bounds()]

    expected = {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "int", "min": 2, "max": 8}},
    ]}
    assert to_ir(Constrained) == expected
    codec = compile(Constrained, plan=plan)
    assert codec.fingerprint == fingerprint
    assert codec.artifact == compile_ir(expected, plan=plan).artifact
    plain = {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "int"}}]}
    assert codec.fingerprint != compile_ir(plain, plan=plan).fingerprint
    for value in (2, 8):
        assert codec.decode(codec.encode({"x": value})) == Constrained(x=value).model_dump()
    for value in (1, 9):
        with pytest.raises(ValidationError):
            Constrained(x=value)
        with pytest.raises(EncodeError) as err:
            codec.encode({"x": value})
        assert err.value.code == "range"


@pytest.mark.parametrize("annotation,node,value", [
    (list[Annotated[int, Field(ge=0)]],
     {"kind": "array", "element": {"kind": "int", "min": 0}}, [0, 2]),
    (list[conint(ge=0)],
     {"kind": "array", "element": {"kind": "int", "min": 0}}, [0, 2]),
    (Annotated[int, Field(ge=0)] | None, {"kind": "nullable", "inner": {"kind": "int", "min": 0}}, 2),
    (Optional[conint(ge=0)], {"kind": "nullable", "inner": {"kind": "int", "min": 0}}, 2),
    (Annotated[int | None, Field(ge=0)], {"kind": "nullable", "inner": {"kind": "int", "min": 0}}, 2),
    (list[list[Annotated[int, Field(ge=0)]]],
     {"kind": "array", "element": {"kind": "array", "element": {"kind": "int", "min": 0}}}, [[0, 2], []]),
    (list[Annotated[int, Ge(0)] | None],
     {"kind": "array", "element": {"kind": "nullable", "inner": {"kind": "int", "min": 0}}}, [None, 0, 2]),
    (list[Annotated[int | None, Field(ge=0)]],
     {"kind": "array", "element": {"kind": "nullable", "inner": {"kind": "int", "min": 0}}}, [None, 0, 2]),
    (list[Annotated[list[int], Field(max_length=3)]],
     {"kind": "array", "element": {"kind": "array", "element": {"kind": "int"}}}, [[0, 2], []]),
    (list[Annotated[_Nested, Field(description="nested model")]],
     {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "n", "type": {"kind": "int"}}]}},
     [{"n": 2}]),
    (list[Annotated[_Tag, Field(description="nested enum")]],
     {"kind": "array", "element": {"kind": "enum", "members": ["a", "b"]}}, ["a", "b"]),
    (list[conint(ge=0, le=10, strict=True, multiple_of=2)],
     {"kind": "array", "element": {"kind": "int", "min": 0, "max": 10}}, [0, 2, 10]),
    (list[confloat(ge=0, le=10)],
     {"kind": "array", "element": {"kind": "float64"}}, [0.0, 2.5]),
    (list[constr(max_length=3)],
     {"kind": "array", "element": {"kind": "string"}}, ["a", "abc"]),
    (list[Annotated[int, None, Field(ge=0), object(), Le(10)]],
     {"kind": "array", "element": {"kind": "int", "min": 0, "max": 10}}, [0, 10]),
    (list[Annotated[int, _Bounds()]],
     {"kind": "array", "element": {"kind": "int", "min": 2, "max": 8}}, [2, 8]),
], ids=["field-list", "conint-list", "nullable-field", "optional-conint", "annotated-optional",
        "nested-list", "nullable-element", "annotated-nullable-element", "annotated-list",
        "annotated-model", "annotated-enum", "ignored-int-metadata", "confloat-list", "constr-list",
        "mixed-metadata", "grouped-metadata"])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_nested_annotated_constraints(annotation, node, value, plan):
    model = create_model("Constrained", x=(annotation, ...))
    field = {"name": "x", "type": node}
    if node["kind"] == "nullable":
        field["type"] = node["inner"]
        field["nullable"] = True
    assert to_ir(model) == {"kind": "struct", "fields": [field]}
    codec = compile(model, validate=True, plan=plan)
    values = [value, None] if field.get("nullable") else [value]
    for item in values:
        payload = {"x": item}
        expected = model.model_validate(payload)
        assert codec.decode(codec.encode(payload)) == expected
        assert codec.decode_body(codec.encode_body(expected)) == expected


@pytest.mark.parametrize("annotation,value", [
    (list[Annotated[int, Field(ge=0)]], [-1]),
    (list[conint(ge=0)], [-1]),
    (Annotated[int, Field(ge=0)] | None, -1),
    (Optional[conint(ge=0)], -1),
    (Annotated[int | None, Field(ge=0)], -1),
    (list[list[Annotated[int, Ge(0)]]], [[-1]]),
    (list[Annotated[int, Ge(0)] | None], [None, -1]),
    (list[Annotated[int | None, Field(ge=0)]], [None, -1]),
])
@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("method", ["encode", "encode_body"])
def test_nested_annotated_bounds_enforced_without_validation(annotation, value, plan, method):
    model = create_model("Constrained", x=(annotation, ...))
    codec = compile(model, validate=False, plan=plan)
    with pytest.raises(EncodeError) as err:
        getattr(codec, method)({"x": value})
    assert err.value.code == "range"


def test_optional_inner_metadata_merges_with_field_metadata():
    class Constrained(BaseModel):
        x: Annotated[int, Field(ge=0)] | None = Field(None, le=10)

    class FieldLevel(BaseModel):
        x: int | None = Field(None, ge=0, le=10)

    expected = {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "int", "min": 0, "max": 10}, "nullable": True},
    ]}
    assert to_ir(Constrained) == to_ir(FieldLevel) == expected
    assert compile(Constrained).artifact == compile(FieldLevel).artifact
    assert compile(Constrained).fingerprint == compile(FieldLevel).fingerprint


@pytest.mark.parametrize("annotation,default,depth,exact", [
    pytest.param(Annotated[int, Ge(10), Ge(0)], ..., 0, True, id="ge-relaxed"),
    pytest.param(Annotated[int, Gt(10), Gt(0)], ..., 0, True, id="gt-relaxed"),
    pytest.param(Annotated[int, Le(0), Le(10)], ..., 0, True, id="le-relaxed"),
    pytest.param(Annotated[int, Lt(0), Lt(10)], ..., 0, True, id="lt-relaxed"),
    pytest.param(Annotated[int, Ge(0), Ge(10)], ..., 0, True, id="ge-tightened"),
    pytest.param(Annotated[int, Le(10), Le(0)], ..., 0, True, id="le-tightened"),
    pytest.param(Annotated[int, Ge(10), Gt(0)], ..., 0, True, id="mixed-lower"),
    pytest.param(Annotated[int, Le(0), Lt(10)], ..., 0, True, id="mixed-upper"),
    pytest.param(Annotated[int, Interval(ge=-1.0, gt=0.0, le=10.0, lt=9.0)], ..., 0, True,
                 id="integral-float-interval"),
    pytest.param(Annotated[int, Interval(ge=10, le=10), Interval(ge=0, le=12)], ..., 0, True,
                 id="repeated-interval"),
    pytest.param(Annotated[int, Interval(ge=10, gt=-1, le=0, lt=11), Ge(0), Le(10)], ..., 0, True,
                 id="interval-before-bounds"),
    pytest.param(Annotated[int, Ge(10), Le(0), Interval(ge=0, le=10)], ..., 0, True,
                 id="interval-after-bounds"),
    pytest.param(Annotated[int, Field(ge=10), Field(ge=0)], ..., 0, True, id="repeated-field"),
    pytest.param(Annotated[int, Ge(10)], Field(ge=0), 0, True, id="field-before-type-tightened"),
    pytest.param(Annotated[int, Field(ge=0)], Field(ge=10), 0, True, id="field-before-type-relaxed"),
    pytest.param(Annotated[Annotated[int, Ge(10)], Ge(0)], ..., 0, True, id="nested-annotated"),
    pytest.param(Annotated[Optional[Annotated[int, Ge(10)]], Ge(0)], ..., 0, True,
                 id="optional-outer-relaxed"),
    pytest.param(Annotated[Optional[Annotated[int, Ge(0)]], Ge(10)], ..., 0, True,
                 id="optional-outer-tightened"),
    pytest.param(Optional[Annotated[int, Ge(10)]], Field(ge=0), 0, True, id="optional-field-outer"),
    pytest.param(Annotated[Optional[Annotated[int, Ge(10)]], Field(ge=5)], Field(ge=0), 0, True,
                 id="optional-three-scopes"),
    pytest.param(list[Annotated[int, Ge(10), Ge(0)]], ..., 1, True, id="list-repeated"),
    pytest.param(list[Annotated[Optional[Annotated[int, Le(0)]], Le(10)]], ..., 1, True,
                 id="list-optional-scopes"),
    pytest.param(Annotated[int, _RepeatedBounds()], ..., 0, True, id="grouped-repeated"),
    pytest.param(list[Annotated[int, _RepeatedBounds()]], ..., 1, True, id="list-grouped-repeated"),
    pytest.param(Annotated[int, Ge(10), AfterValidator(_identity), Ge(0)], ..., 0, False,
                 id="validator-between-bounds"),
    pytest.param(Annotated[int, Ge(10), BeforeValidator(_identity), Ge(0)], ..., 0, False,
                 id="before-validator-between-bounds"),
    pytest.param(Annotated[int, Ge(10), WrapValidator(lambda value, handler: handler(value)), Ge(0)], ..., 0, False,
                 id="wrap-validator-between-bounds"),
    pytest.param(Annotated[int, _GeSubclass(10)], ..., 0, True, id="ge-subclass"),
    pytest.param(Annotated[int, _NestedBounds()], ..., 0, True, id="nested-grouped"),
    pytest.param(Annotated[int, _CustomInterval(ge=10, le=10)], ..., 0, True, id="custom-interval"),
    pytest.param(Annotated[int, _FieldBounds()], ..., 0, True, id="grouped-field-info"),
    pytest.param(list[Annotated[int, Ge(10), AfterValidator(_identity), Ge(0)]], ..., 1, False,
                 id="list-validator-between-bounds"),
    pytest.param(Optional[Annotated[int, Ge(10), AfterValidator(_identity)]], Field(ge=0), 0, False,
                 id="optional-field-validator-between-bounds"),
    pytest.param(Annotated[Optional[Annotated[int, Ge(10), AfterValidator(_identity)]], Ge(0)], ..., 0, False,
                 id="optional-outer-validator-between-bounds"),
    pytest.param(list[Annotated[Optional[Annotated[int, Ge(10), AfterValidator(_identity)]], Ge(0)]], ..., 1, False,
                 id="list-optional-validator-between-bounds"),
    pytest.param(Annotated[int, Ge(0), Le(10), _IntChain()], ..., 0, True, id="multiple-int-schemas"),
    pytest.param(Annotated[int, Ge(10), AfterValidator(_shift)], ..., 0, False,
                 id="after-shifts-value"),
    pytest.param(Annotated[int, Ge(10), AfterValidator(_shift), Ge(0)], ..., 0, False,
                 id="after-shifts-then-checks"),
    pytest.param(Annotated[int, Ge(10), WrapValidator(lambda value, handler: _shift(value))], ..., 0, False,
                 id="wrap-skips-handler-and-shifts"),
    pytest.param(Annotated[int, Ge(10), BeforeValidator(_identity)], ..., 0, False,
                 id="before-output-is-bounded"),
    pytest.param(Annotated[int, Ge(10), BeforeValidator(_shift)], ..., 0, False,
                 id="before-shifts-value"),
    pytest.param(list[Annotated[int, Ge(10), AfterValidator(_shift)]], ..., 1, False,
                 id="list-after-shifts-value"),
    pytest.param(Optional[Annotated[int, Ge(10), AfterValidator(_shift)]], ..., 0, False,
                 id="optional-after-shifts-value"),
    pytest.param(Annotated[int, Ge(10), _ShiftChain()], ..., 0, False,
                 id="chain-last-step-shifts-value"),
    pytest.param(Annotated[int, Ge(10), _LastIntChain()], ..., 0, False,
                 id="chain-last-int-defines-output-bounds"),
    pytest.param(Annotated[int, _RefChain()], ..., 0, False, id="chain-definitions-and-refs"),
    pytest.param(Annotated[list[Annotated[int, Ge(10)]], AfterValidator(lambda xs: [_shift(x) for x in xs])],
                 ..., 1, False, id="container-after-shifts-elements"),
    pytest.param(Annotated[list[Annotated[int, Ge(10)]], WrapValidator(lambda xs, h: [_shift(x) for x in h(xs)])],
                 ..., 1, False, id="container-wrap-shifts-elements"),
    pytest.param(Annotated[list[Annotated[int, Ge(10)]], PlainValidator(lambda xs: [_shift(x) for x in xs])],
                 ..., 1, False, id="container-plain-shifts-elements"),
    pytest.param(Optional[Annotated[list[Annotated[int, Ge(10)]], AfterValidator(lambda xs: [_shift(x) for x in xs])]],
                 ..., 1, False, id="optional-container-after-shifts-elements"),
    pytest.param(list[Annotated[list[Annotated[int, Ge(10)]], AfterValidator(lambda xs: [_shift(x) for x in xs])]],
                 ..., 2, False, id="nested-container-after-shifts-elements"),
    pytest.param(Annotated[int, Ge(10)], Field(default=-90), 0, False, id="unchecked-static-default"),
    pytest.param(Annotated[int, _Bounds()], Field(default=-90), 0, False, id="unchecked-grouped-default"),
    pytest.param(Annotated[int, Ge(10)], Field(default=-90, validate_default=True), 0, True,
                 id="checked-static-default"),
    pytest.param(Optional[Annotated[int, Ge(10)]], Field(default=-90), 0, False,
                 id="unchecked-optional-static-default"),
])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_integer_bounds_accept_pydantic_held_values(annotation, default, depth, exact, plan):
    model = create_model("Constrained", x=(annotation, default))
    _assert_integer_leaf_matches_model_output(model)
    codec = compile(model, validate=False, plan=plan)
    accepted = 0
    for candidate in [*range(-3, 14), *range(-200, -79), *range(97, 114), None]:
        value = candidate
        for _ in range(depth):
            value = [value]
        payload = {"x": value}
        try:
            instance = model.model_validate(payload)
        except ValidationError:
            model_accepts = False
        else:
            model_accepts = True
            accepted += 1
            held = instance.model_dump()
            assert codec.decode(codec.encode(instance)) == held
            assert codec.decode_body(codec.encode_body(instance)) == held
        if exact:
            try:
                encoded = codec.encode(payload)
                codec_accepts = True
            except EncodeError:
                codec_accepts = False
            assert codec_accepts == model_accepts, payload
            if codec_accepts:
                assert codec.decode(encoded) == payload
    assert accepted > 0


@pytest.mark.parametrize("mode", ["after", "wrap", "plain", "before"])
@pytest.mark.parametrize("grouped", [False, True])
@pytest.mark.parametrize("validate_default", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_decorated_field_validators_use_the_models_output(mode, grouped, validate_default, plan):
    annotation = Annotated[int, _Bounds()] if grouped else int
    default = Field(default=5, validate_default=validate_default) if grouped else Field(
        default=50, ge=0, validate_default=validate_default,
    )

    def shift(cls, value, *args):
        if mode == "wrap":
            value = args[0](value)
        return value - 100

    # Pydantic checks signatures even when the validator accepts unused arguments.
    if mode == "wrap":
        def validator(cls, value, handler):
            return shift(cls, value, handler)
    else:
        def validator(cls, value):
            return shift(cls, value)

    model = create_model("Decorated", x=(annotation, default), __validators__={
        "shift": field_validator("x", mode=mode)(classmethod(validator)),
    })
    codec = compile(model, validate=False, plan=plan)
    expected = {"kind": "int"}
    if mode == "before":
        expected.update({"min": 2, "max": 8} if grouped else {"min": 0})
    assert codec.ir["fields"][0]["type"] == expected
    _assert_integer_leaf_matches_model_output(model)
    accepted = 0
    for payload in [{}, *({"x": value} for value in (-90, 5, 50, 105, 150))]:
        try:
            instance = model.model_validate(payload)
        except ValidationError:
            continue
        accepted += 1
        assert codec.decode(codec.encode(instance)) == instance.model_dump()
        assert codec.decode_body(codec.encode_body(instance)) == instance.model_dump()
    assert accepted > 0


@pytest.mark.parametrize("validator", [
    AfterValidator(lambda xs: [v - 100 for v in xs]),
    WrapValidator(lambda xs, handler: [v - 100 for v in handler(xs)]),
    PlainValidator(lambda xs: [v - 100 for v in xs]),
])
@pytest.mark.parametrize("shape", ["list", "optional", "optional-items", "nested-list", "nested-model"])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_container_validators_drop_every_descendant_bound(validator, shape, plan):
    annotation = Annotated[list[Annotated[int, Ge(10)]], validator]
    value = [10]
    if shape == "optional":
        annotation = Optional[annotation]
    elif shape == "optional-items":
        annotation = list[Annotated[Optional[list[Annotated[int, Ge(10)]]], validator]]
        value = [[10]]
    elif shape == "nested-list":
        annotation = list[annotation]
        value = [[10]]
    elif shape == "nested-model":
        class Inner(BaseModel):
            x: annotation
        annotation = list[Optional[Inner]]
        value = [{"x": [10]}]
    model = create_model("Container", x=(annotation, ...))
    codec = compile(model, validate=False, plan=plan)
    instance = model(x=value)
    expected = instance.model_dump()
    assert "-90" in str(expected)

    def assert_unbounded(node):
        if node["kind"] == "int":
            assert node == {"kind": "int"}
        elif node["kind"] == "array":
            assert_unbounded(node["element"])
        elif node["kind"] == "nullable":
            assert_unbounded(node["inner"])
        elif node["kind"] == "struct":
            for field in node["fields"]:
                assert_unbounded(field["type"])
    assert_unbounded(codec.ir)
    assert codec.decode(codec.encode(instance)) == expected
    assert codec.decode_body(codec.encode_body(instance)) == expected


@pytest.mark.parametrize("mode", ["after", "wrap", "plain", "before"])
@pytest.mark.parametrize("optional", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_validator_around_nested_model_container(mode, optional, plan):
    class Inner(BaseModel):
        x: Annotated[int, Ge(10)]

    def shift(items):
        return [item.model_copy(update={"x": item.x - 100}) for item in items]

    if mode == "wrap":
        validator = WrapValidator(lambda items, handler: shift(handler(items)))
    elif mode == "plain":
        validator = PlainValidator(lambda items: shift([Inner.model_validate(item) for item in items]))
    elif mode == "before":
        validator = BeforeValidator(lambda items: [{"x": item["x"] - 100} for item in items])
    else:
        validator = AfterValidator(shift)
    annotation = Annotated[list[Inner], validator]
    if optional:
        annotation = Optional[annotation]
    model = create_model("Outer", x=(annotation, ...))
    instance = model(x=[{"x": 110 if mode == "before" else 10}])
    codec = compile(model, validate=False, plan=plan)
    leaf = codec.ir["fields"][0]["type"]["element"]["fields"][0]["type"]
    assert leaf == ({"kind": "int", "min": 10} if mode == "before" else {"kind": "int"})
    warns = None if mode == "plain" else False
    with serializer_warnings(warns, match="Expected `Inner`") as expected_warnings:
        expected = instance.model_dump()
    for encode, decode in ((codec.encode, codec.decode), (codec.encode_body, codec.decode_body)):
        with serializer_warnings(warns, match="Expected `Inner`") as actual_warnings:
            body = encode(instance)
        assert decode(body) == expected
        assert warning_details(actual_warnings) == warning_details(expected_warnings)


@pytest.mark.parametrize("default,field_validates,config_validates", [
    (-90, None, False), (-90, False, True),
    (-90, True, False), (-90, None, True),
    (10, None, False), (100, False, False),
])
@pytest.mark.parametrize("grouped", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_static_integer_defaults_respect_validate_default(default, field_validates, config_validates,
                                                        grouped, plan):
    annotation = Annotated[int, _FieldBounds()] if grouped else Annotated[int, Ge(10)]
    # Use the same lower bound for the plain and GroupedMetadata cases.
    if grouped:
        default = -90 if default < 10 else 5
    minimum = 2 if grouped else 10
    model = create_model("Defaults", __config__=ConfigDict(validate_default=config_validates), x=(
        annotation, Field(default=default, validate_default=field_validates),
    ))
    expected = {"kind": "int", "min": minimum}
    if grouped:
        expected["max"] = 8
    codec = compile(model, validate=False, plan=plan)
    assert codec.ir["fields"][0]["type"] == expected
    validates = config_validates if field_validates is None else field_validates
    if validates and default < minimum:
        with pytest.raises(ValidationError):
            model()
    else:
        instance = model()
        for encode, decode in ((codec.encode, codec.decode), (codec.encode_body, codec.decode_body)):
            if default < minimum:
                with pytest.raises(EncodeError) as error:
                    encode(instance)
                assert error.value.code == "range"
            else:
                assert decode(encode(instance)) == instance.model_dump()


@pytest.mark.parametrize("shape", ["scalar", "optional", "list", "nested-list", "model"])
@pytest.mark.parametrize("factory", [False, True])
@pytest.mark.parametrize("field_validates,config_validates", [
    (None, False), (False, True), (True, False), (None, True),
])
@pytest.mark.parametrize("outside", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_all_defaults_keep_declared_bounds(shape, factory, field_validates, config_validates, outside, plan):
    annotation = Annotated[int, Ge(10)]
    default = -90 if outside else 10
    leaf = {"kind": "int", "min": 10}
    expected = leaf
    if shape == "optional":
        annotation = Optional[annotation]
    elif shape in ("list", "nested-list"):
        for _ in range(2 if shape == "nested-list" else 1):
            annotation = list[annotation]
            default = [default]
            expected = {"kind": "array", "element": expected}
    elif shape == "model":
        annotation = create_model("DefaultInner", x=(annotation, ...))
        default = {"x": default}
        expected = {"kind": "struct", "fields": [{"name": "x", "type": leaf}]}
    calls = 0

    def make_default():
        nonlocal calls
        calls += 1
        return deepcopy(default)

    field = Field(default_factory=make_default, validate_default=field_validates) if factory else Field(
        default=default, validate_default=field_validates,
    )
    model = create_model("Defaults", __config__=ConfigDict(validate_default=config_validates), x=(annotation, field))
    codec = compile(model, validate=False, plan=plan)
    assert codec.ir["fields"][0]["type"] == expected
    assert calls == 0
    validates = config_validates if field_validates is None else field_validates
    if validates and outside:
        with pytest.raises(ValidationError):
            model()
        return
    instance = model()
    assert calls == int(factory)
    warns = shape == "model" and not validates
    with serializer_warnings(warns, match="Expected `DefaultInner`") as expected_warnings:
        expected_value = instance.model_dump()
    for encode, decode in ((codec.encode, codec.decode), (codec.encode_body, codec.decode_body)):
        with serializer_warnings(warns, match="Expected `DefaultInner`") as actual_warnings:
            if outside:
                with pytest.raises(EncodeError) as error:
                    encode(instance)
                assert error.value.code == "range"
            else:
                body = encode(instance)
        if not outside:
            assert decode(body) == expected_value == {"x": default}
        assert warning_details(actual_warnings) == warning_details(expected_warnings)


@pytest.mark.parametrize("mode", ["after", "wrap", "before"])
@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_model_validators_keep_declared_field_bounds(mode, nested, plan):
    if mode == "after":
        def validator(self):
            self.x -= 100
            return self
    elif mode == "wrap":
        def validator(cls, value, handler):
            instance = handler(value)
            instance.x -= 100
            return instance
        validator = classmethod(validator)
    else:
        def validator(cls, value):
            return {**value, "x": value["x"] - 100}
        validator = classmethod(validator)
    inner = create_model("ModelValidated", x=(int, Field(ge=0)), __validators__={
        "shift": model_validator(mode=mode)(validator),
    })
    model = create_model("Nested", x=(list[inner], ...)) if nested else inner
    value = 150 if mode == "before" else 50
    instance = model(x=[{"x": value}]) if nested else model(x=value)
    codec = compile(model, validate=False, plan=plan)
    leaf = codec.ir["fields"][0]["type"]
    if nested:
        leaf = leaf["element"]["fields"][0]["type"]
    assert leaf == {"kind": "int", "min": 0}
    for encode in (codec.encode, codec.encode_body):
        if mode == "before":
            assert codec.decode_body(codec.encode_body(instance)) == instance.model_dump()
        else:
            with pytest.raises(EncodeError) as error:
                encode(instance)
            assert error.value.code == "range"
    assert "bypass field validation" in to_ir.__doc__


@pytest.mark.parametrize("plan,fingerprint", [
    ("row", "675e12f1a83dd9e0bf3ed14a6c1083ba"),
    ("columnar", "c5a1c60c5399f7ebf387cb63ff13a884"),
])
@pytest.mark.parametrize("mode", ["after", "wrap"])
def test_model_validator_with_nan_default_keeps_bounds(mode, plan, fingerprint):
    class Model(BaseModel):
        x: int = Field(ge=0, le=100)
        y: float = float("nan")

        if mode == "after":
            @model_validator(mode="after")
            def check(self):
                return self
        else:
            @model_validator(mode="wrap")
            @classmethod
            def check(cls, value, handler):
                return handler(value)

    # IR, fingerprints and finite body bytes match origin/main (5e555fe).
    expected = {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "int", "min": 0, "max": 100}},
        {"name": "y", "type": {"kind": "float64"}},
    ]}
    assert to_ir(Model) == expected
    codec = compile(Model, validate=False, plan=plan)
    assert codec.ir == expected
    assert codec.fingerprint == fingerprint
    instance = Model(x=10, y=1.5)
    assert codec.encode_body(instance).hex() == "0a000000000000f83f"
    assert codec.decode(codec.encode(instance)) == instance.model_dump()
    assert codec.decode_body(codec.encode_body(instance)) == instance.model_dump()


@pytest.mark.parametrize("plan,fingerprint", [
    ("row", "8c35cc9a22d846a6bc8e96a173a21f2f"),
    ("columnar", "7892c2301f77b48b4c72cab3401810d1"),
])
@pytest.mark.parametrize("mode", ["after", "wrap"])
def test_model_validator_with_shared_nested_definition_keeps_bounds(mode, plan, fingerprint):
    class Leaf(BaseModel):
        x: int = Field(ge=10, le=100)

    class Inner(BaseModel):
        leaf: Leaf
        y: int = Field(ge=0)

        if mode == "after":
            @model_validator(mode="after")
            def shift(self):
                self.y -= 100
                return self
        else:
            @model_validator(mode="wrap")
            @classmethod
            def shift(cls, value, handler):
                instance = handler(value)
                instance.y -= 100
                return instance

    class Outer(BaseModel):
        a: Inner
        b: Leaf

    leaf_ir = {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "int", "min": 10, "max": 100}},
    ]}
    expected = {"kind": "struct", "fields": [
        {"name": "a", "type": {"kind": "struct", "fields": [
            {"name": "leaf", "type": leaf_ir},
            {"name": "y", "type": {"kind": "int", "min": 0}},
        ]}},
        {"name": "b", "type": leaf_ir},
    ]}
    assert to_ir(Outer) == expected
    codec = compile(Outer, validate=False, plan=plan)
    # origin/main (5e555fe) fingerprints must survive definition inlining.
    assert compile_ir(to_ir(Outer), plan=plan).fingerprint == fingerprint
    assert codec.fingerprint == fingerprint
    instance = Outer(a={"leaf": {"x": 10}, "y": 10}, b={"x": 20})
    assert instance.a.y == -90
    for encode in (codec.encode, codec.encode_body):
        with pytest.raises(EncodeError) as error:
            encode(instance)
        assert error.value.code == "range"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_field_and_model_validators_using_the_same_function_remain_distinct(plan):
    def shift(value):
        value.x -= 100
        return value

    inner = create_model("Inner", x=(int, Field(ge=0)), __validators__={
        "shift": model_validator(mode="after")(shift),
    })
    outer = create_model("Outer", x=(Annotated[inner, AfterValidator(shift)], ...))
    assert to_ir(inner)["fields"][0]["type"] == {"kind": "int", "min": 0}
    codec = compile(outer, validate=False, plan=plan)
    assert codec.ir["fields"][0]["type"]["fields"][0]["type"] == {"kind": "int"}
    instance = outer(x={"x": 150})
    assert instance.x.x == -50
    assert codec.decode(codec.encode(instance)) == {"x": {"x": -50}}
    assert codec.decode_body(codec.encode_body(instance)) == {"x": {"x": -50}}


@pytest.mark.parametrize("mode", ["after", "wrap"])
@pytest.mark.parametrize("model_validator_present", [False, True])
@pytest.mark.parametrize("shared_function", [False, True])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_field_schema_hook_moving_model_ref_is_a_bounds_barrier(
    mode, model_validator_present, shared_function, plan,
):
    def shift(value):
        return value.model_copy(update={"x": value.x - 100})

    def wrap(value, handler):
        return shift(handler(value))

    validator = shift if mode == "after" else wrap
    validators = {"shift": model_validator(mode=mode)(validator)} if model_validator_present else {}
    inner = create_model("Inner", x=(int, Field(ge=10)), __validators__=validators)

    class Shift:
        def __get_pydantic_core_schema__(self, source, handler):
            schema = dict(handler.resolve_ref_schema(handler(source)))
            ref = schema.pop("ref")
            if mode == "after":
                function = shift if shared_function else lambda value: shift(value)
                return core_schema.no_info_after_validator_function(function, schema, ref=ref)
            function = wrap if shared_function else lambda value, handler: wrap(value, handler)
            return core_schema.no_info_wrap_validator_function(function, schema, ref=ref)

    outer = create_model("Outer", a=(Annotated[inner, Shift()], ...))
    assert to_ir(inner)["fields"][0]["type"] == {"kind": "int", "min": 10}
    codec = compile(outer, validate=False, plan=plan)
    assert codec.ir["fields"][0]["type"]["fields"][0]["type"] == {"kind": "int"}
    instance = outer(a={"x": 10})
    assert instance.a.x == (-190 if model_validator_present else -90)
    assert codec.decode(codec.encode(instance)) == instance.model_dump()
    assert codec.decode_body(codec.encode_body(instance)) == instance.model_dump()


@pytest.mark.parametrize("mode", ["after", "wrap"])
@pytest.mark.parametrize("lower_bound", [
    0, 999,
    pytest.param(10.0, id="float-instead-of-int"),
    pytest.param(_EqualFloat(10), id="spoofed-float-equality"),
])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_field_hook_replacing_model_validator_with_modified_body_is_a_barrier(
    mode, lower_bound, plan,
):
    def shift(value):
        return value.model_copy(update={"x": value.x - 100})

    def wrap(value, handler):
        return shift(handler(value))

    validator = shift if mode == "after" else wrap
    inner = create_model("Inner", x=(int, Field(ge=10)), __validators__={
        "shift": model_validator(mode=mode)(validator),
    })

    class Replace:
        def __get_pydantic_core_schema__(self, source, handler):
            schema = deepcopy(handler.resolve_ref_schema(handler(source)))
            ref = schema.pop("ref")
            body = schema["schema"]
            body["schema"]["fields"]["x"]["schema"]["ge"] = lower_bound
            if mode == "after":
                return core_schema.no_info_after_validator_function(shift, body, ref=ref)
            return core_schema.no_info_wrap_validator_function(wrap, body, ref=ref)

    outer = create_model("Outer", a=(Annotated[inner, Replace()], ...))
    assert to_ir(inner)["fields"][0]["type"] == {"kind": "int", "min": 10}
    codec = compile(outer, validate=False, plan=plan)
    # Pydantic 2.10 normalizes integral float bounds, making the bodies identical.
    normalized_bound = (2, 10) <= PYDANTIC_VERSION < (2, 11) and isinstance(lower_bound, float)
    expected = {"kind": "int", "min": 10} if normalized_bound else {"kind": "int"}
    assert codec.ir["fields"][0]["type"]["fields"][0]["type"] == expected
    instance = outer(a={"x": max(10, lower_bound)})
    assert instance.a.x == max(10, lower_bound) - 100
    if normalized_bound:
        for encode in (codec.encode, codec.encode_body):
            with pytest.raises(EncodeError) as error:
                encode(instance)
            assert error.value.code == "range"
    else:
        assert codec.decode(codec.encode(instance)) == instance.model_dump()
        assert codec.decode_body(codec.encode_body(instance)) == instance.model_dump()


@pytest.mark.parametrize("left,right,equal", [
    (None, None, True),
    (10, 10, True),
    (10, 11, False),
    (10.0, 10.0, True),
    (float("nan"), float("nan"), True),
    (_EqualFloat("nan"), float("nan"), True),
    (float("nan"), 10.0, False),
    (True, 1, False),
    (1, True, False),
    (True, 1.0, False),
    (10.0, 10, False),
    (10, 10.0, False),
    (_EqualFloat(10), 10.0, False),
    (10.0, _EqualFloat(10), False),
    (_EqualFloat(999), 10, False),
    (10, _EqualFloat(999), False),
    (_EqualFloat(999), _EqualFloat(10), True),
])
def test_model_schema_comparison_matches_scalar_identity_nan_or_exact_type(left, right, equal):
    assert _same_schema({"value": left}, {"value": right}, {}, {}) is equal


def test_model_schema_comparison_matches_scalar_identity_before_equality():
    class IdentityOnly:
        def __eq__(self, other):
            raise AssertionError("identity must not call equality")

    value = IdentityOnly()
    assert _same_schema({"value": value}, {"value": value}, {}, {})


def test_model_schema_comparison_resolves_nested_and_recursive_definitions():
    child = {"type": "definition-ref", "schema_ref": "node"}
    node = {"type": "nullable", "schema": child, "ref": "node"}
    leaf = {"type": "int", "ge": 10, "ref": "leaf"}
    referenced = {"type": "definitions", "schema": {
        "type": "list", "items_schema": child,
        "metadata": ({"type": "definitions", "schema": {
            "type": "definition-ref", "schema_ref": "leaf",
        }, "definitions": [leaf]}, leaf),
    }, "definitions": [node, leaf]}
    inlined = {"metadata": (leaf, leaf), "items_schema": node, "type": "list"}
    assert _same_schema(referenced, inlined, {}, {})
    changed = deepcopy(inlined)
    changed["metadata"][0]["ge"] = 999
    assert not _same_schema(referenced, changed, {}, {})
    # Independent registries must not let the model's own definition hide edits.
    assert not _same_schema(child, child, {"node": leaf}, {"node": {**leaf, "ge": 0}})


@pytest.mark.parametrize("alias", [False, True])
def test_model_schema_comparison_matches_reference_cycles_by_name(alias):
    ref = {"type": "definition-ref", "schema_ref": "node"}
    definitions = {"node": ref}
    if alias:
        definitions = {"node": {"type": "definition-ref", "schema_ref": "alias"}, "alias": ref}
    assert _same_schema(ref, ref, definitions, definitions)
    other = {"type": "definition-ref", "schema_ref": "other"}
    assert not _same_schema(ref, other, definitions, {"other": other})


def test_model_schema_comparison_is_iterative_for_deep_descendants():
    inlined = {"type": "int", "ge": 10, "ref": "leaf"}
    definitions = {"leaf": inlined}
    referenced = {"type": "definition-ref", "schema_ref": "leaf"}
    for index in range(1500):
        name = f"node{index}"
        inlined = {"type": "nullable", "schema": inlined, "ref": name}
        definitions[name] = {"type": "nullable", "schema": referenced, "ref": name}
        referenced = {"type": "definition-ref", "schema_ref": name}
    assert _same_schema(referenced, inlined, definitions, {})
    assert not _same_schema(referenced, inlined, {**definitions, "leaf": {
        "type": "int", "ge": 999, "ref": "leaf",
    }}, {})


@pytest.mark.parametrize("sequence", [False, True])
def test_model_schema_comparison_rejects_unnamed_container_cycles(sequence):
    schema = {"type": "int", "ge": 10}
    schema["metadata"] = [schema] if sequence else schema
    with pytest.raises(_SchemaMismatch):
        _same_schema(schema, schema, {}, {})


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_inherited_model_validator_stack_with_info_keeps_bounds(plan):
    class Parent(BaseModel):
        x: int = Field(ge=10)

        @model_validator(mode="before")
        @classmethod
        def before(cls, value, info):
            return value

        @model_validator(mode="wrap")
        @classmethod
        def wrap(cls, value, handler, info):
            return handler(value)

        @model_validator(mode="after")
        def after(self, info):
            self.x -= 100
            return self

    class Child(Parent):
        @model_validator(mode="wrap")
        @classmethod
        def outer_wrap(cls, value, handler):
            return handler(value)

    model = create_model("Outer", a=(Child, ...), b=(Child, ...))
    codec = compile(model, validate=False, plan=plan)
    for field in codec.ir["fields"]:
        assert field["type"]["fields"][0]["type"] == {"kind": "int", "min": 10}
    instance = model(a={"x": 10}, b={"x": 10})
    assert instance.a.x == instance.b.x == -90
    for encode in (codec.encode, codec.encode_body):
        with pytest.raises(EncodeError) as error:
            encode(instance)
        assert error.value.code == "range"


@pytest.mark.parametrize("convert", [to_ir, compile])
@pytest.mark.parametrize("mutual", [False, True])
def test_recursive_models_are_unsupported_with_field_path(convert, mutual):
    class Recursive(BaseModel):
        children: list["Recursive"]

    class Other(BaseModel):
        child: Recursive

    # Python 3.10 can leave string arguments in container field annotations.
    Recursive.model_fields["children"].annotation = list[Other if mutual else Recursive]
    Recursive.model_rebuild(force=True)
    with pytest.raises(UnsupportedSchemaError) as error:
        convert(Recursive)
    assert error.value.code == "unsupported"
    assert error.value.path == ("$.children[].child" if mutual else "$.children[]")
    assert "recursive model" in str(error.value)


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_generic_models_and_forward_refs_resolve_definitions(plan):
    item_type = TypeVar("item_type")

    class Batch(BaseModel, Generic[item_type]):
        items: list[item_type]

    bounded_batch = Batch[Annotated[int, Ge(10)]]

    class Envelope(BaseModel):
        first: "ForwardBatch"
        rest: list[Optional["ForwardBatch"]]

    Envelope.model_rebuild(_types_namespace={"ForwardBatch": bounded_batch})
    assert Envelope.__pydantic_core_schema__["type"] == "definitions"
    codec = compile(Envelope, plan=plan)
    first = codec.ir["fields"][0]["type"]
    repeated = codec.ir["fields"][1]["type"]["element"]["inner"]
    assert first == repeated == {"kind": "struct", "fields": [
        {"name": "items", "type": {"kind": "array", "element": {"kind": "int", "min": 10}}},
    ]}
    instance = Envelope(first={"items": [10]}, rest=[None, {"items": [20]}])
    assert codec.decode(codec.encode(instance)) == instance.model_dump()
    with pytest.raises(EncodeError) as error:
        codec.encode({"first": {"items": [-90]}, "rest": []})
    assert error.value.code == "range"


@pytest.mark.parametrize("bad_schema", [
    {"type": "unexpected"}, {"type": "list"},
    {"type": "definition-ref", "schema_ref": "missing"},
    {"type": "chain", "steps": []},
    {"type": "list", "items_schema": {"type": "nullable"}},
])
def test_unmatched_field_schemas_drop_bounds_without_raw_errors(bad_schema, monkeypatch):
    class M(BaseModel):
        x: list[Annotated[int, Ge(10)]]
        y: int = Field(ge=0)

    schema = deepcopy(M.__pydantic_core_schema__)
    schema["schema"]["fields"]["x"]["schema"] = bad_schema
    monkeypatch.setattr(M, "__pydantic_core_schema__", schema)
    assert to_ir(M) == {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "array", "element": {"kind": "int"}}},
        {"name": "y", "type": {"kind": "int", "min": 0}},
    ]}


@pytest.mark.parametrize("annotation,default,int_schema", [
    (Annotated[int, Ge(10)], Field(ge=0), {"type": "int", "ge": 10}),
    (Annotated[int, Field(ge=0)], Field(ge=10),
     {"type": "int", "ge": 10 if PYDANTIC_VERSION < (2, 12) else 0}),
    (Annotated[Optional[Annotated[int, Ge(10)]], Field(ge=5)], Field(ge=0),
     {"type": "int", "ge": 0 if PYDANTIC_VERSION < (2, 12) else 5}),
    (list[Annotated[Optional[Annotated[int, Ge(10)]], Ge(0)]], ...,
     {"type": "int", "ge": 0}),
    (Annotated[int, Ge(10), AfterValidator(_identity), Ge(0)], ...,
     {"type": "int", "ge": 10}),
    (Annotated[int, _GeSubclass(10)], ...,
     {"type": "int", "ge": 10} if PYDANTIC_VERSION < (2, 8, 1) else {"type": "int"}),
    (Annotated[int, _NestedBounds()], ..., {"type": "int"}),
    (Annotated[int, _CustomInterval(ge=10, le=10)], ...,
     {"type": "int", "ge": 2, "le": 8}),
    (Annotated[int, _FieldBounds()], ...,
     {"type": "int", "ge": 2, "le": 8}),
])
def test_integer_leaf_matches_models_own_core_schema(annotation, default, int_schema):
    model = create_model("Constrained", x=(annotation, default))
    schema = model.__pydantic_core_schema__["schema"]["fields"]["x"]["schema"]
    while schema["type"] != "int":
        schema = schema["items_schema"] if schema["type"] == "list" else schema["schema"]
    assert {key: value for key, value in schema.items() if key != "metadata"} == int_schema
    _assert_integer_leaf_matches_model_output(model)


@pytest.mark.parametrize("validator", [
    AfterValidator(_identity), BeforeValidator(_identity),
    WrapValidator(lambda value, handler: handler(value)), PlainValidator(_identity),
])
def test_function_bounds_do_not_constrain_integer_leaf(validator):
    model = create_model("Constrained", x=(Annotated[int, validator, Ge(10)], ...))
    assert to_ir(model)["fields"][0]["type"] == {"kind": "int"}
    codec = compile(model, validate=False)
    with pytest.raises(ValidationError):
        model.model_validate({"x": 0})
    assert codec.decode(codec.encode({"x": 0})) == {"x": 0}


def test_plain_validator_does_not_use_serialization_schema_bounds():
    model = create_model("Constrained", x=(Annotated[int, Ge(10), PlainValidator(_identity)], ...))
    assert model.__pydantic_core_schema__["schema"]["fields"]["x"]["schema"]["type"] == "function-plain"
    assert to_ir(model)["fields"][0]["type"] == {"kind": "int"}
    codec = compile(model, validate=False)
    for value in (-1, 0, 10):
        payload = {"x": value}
        assert model.model_validate(payload).model_dump() == codec.decode(codec.encode(payload)) == payload


@pytest.mark.parametrize("annotation,node", [
    (Annotated[int, Ge(10), AfterValidator(_shift)], {"kind": "int"}),
    (Annotated[int, Ge(10), AfterValidator(_shift), Ge(0)], {"kind": "int"}),
    (Annotated[int, Ge(10), WrapValidator(lambda value, handler: _shift(value))], {"kind": "int"}),
    (Annotated[int, Ge(10), BeforeValidator(_shift)], {"kind": "int", "min": 10}),
    (Annotated[int, BeforeValidator(_identity), Ge(10)], {"kind": "int"}),
    (Annotated[int, Ge(10), _ShiftChain()], {"kind": "int"}),
    (Annotated[int, Ge(10), _LastIntChain()], {"kind": "int", "min": -100, "max": -80}),
    (Annotated[int, _RefChain()], {"kind": "int", "min": 10}),
])
def test_integer_bounds_only_follow_output_schema(annotation, node):
    model = create_model("Constrained", x=(annotation, ...))
    assert to_ir(model)["fields"][0]["type"] == node


@pytest.mark.parametrize("schema", [
    core_schema.lax_or_strict_schema(core_schema.int_schema(ge=10), core_schema.int_schema(le=0)),
    core_schema.json_or_python_schema(core_schema.int_schema(ge=10), core_schema.int_schema(le=0)),
    core_schema.union_schema([core_schema.int_schema(le=0), core_schema.int_schema(ge=10)]),
], ids=["lax-or-strict", "json-or-python", "union"])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_integer_schema_branches_are_unbounded(schema, plan):
    class OutputSchema:
        def __get_pydantic_core_schema__(self, source, handler):
            return deepcopy(schema)

    model = create_model("Constrained", x=(Annotated[int, OutputSchema()], ...))
    assert to_ir(model)["fields"][0]["type"] == {"kind": "int"}
    codec = compile(model, validate=False, plan=plan)
    accepted = 0
    for payload in [{}, *({"x": value} for value in (-90, -3, 0, 10, 13))]:
        try:
            instance = model.model_validate(payload)
        except ValidationError:
            continue
        accepted += 1
        assert codec.decode(codec.encode(instance)) == instance.model_dump()
    assert accepted > 0


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_custom_schema_unvalidated_default_keeps_bounds(plan):
    class OutputSchema:
        def __get_pydantic_core_schema__(self, source, handler):
            return core_schema.with_default_schema(core_schema.int_schema(ge=10), default=-90)

    model = create_model("Constrained", x=(Annotated[int, OutputSchema()], ...))
    codec = compile(model, validate=False, plan=plan)
    assert codec.ir["fields"][0]["type"] == {"kind": "int", "min": 10}
    for encode in (codec.encode, codec.encode_body):
        with pytest.raises(EncodeError) as error:
            encode(model())
        assert error.value.code == "range"
    for value in (-90, -3, 0, 10, 13):
        payload = {"x": value}
        if value < 10:
            with pytest.raises(ValidationError):
                model.model_validate(payload)
        else:
            instance = model.model_validate(payload)
            assert codec.decode(codec.encode(instance)) == payload
            assert codec.decode_body(codec.encode_body(instance)) == payload


@pytest.mark.parametrize("convert", [to_ir, compile])
def test_invalid_integer_metadata_is_unsupported_with_cause(convert):
    annotation = list[Annotated[int, Ge("odd")]]
    with pytest.raises(SchemaError):
        create_model("Invalid", x=(annotation, ...))
    model = create_model("Deferred", __config__=ConfigDict(defer_build=True), x=(annotation, ...))
    with pytest.raises(SchemaError):
        model.model_rebuild(_types_namespace={})
    with pytest.raises(UnsupportedSchemaError) as err:
        convert(model)
    assert err.value.code == "unsupported"
    assert err.value.path == "$.x[]"
    assert isinstance(err.value.__cause__, SchemaError)


def test_unconstrained_integer_leaves_do_not_build_type_adapters(monkeypatch):
    model = create_model("Plain", x=(int, ...), y=(list[int | None], ...),
                         z=(Annotated[int, BeforeValidator(_identity)], ...))

    def unexpected_walk(*args, **kwargs):
        pytest.fail("unconstrained integers must not walk schemas or build TypeAdapters")

    monkeypatch.setattr("pydantic.TypeAdapter", unexpected_walk)
    monkeypatch.setattr("hyperfly.pydantic._apply_bounds", unexpected_walk)
    assert to_ir(model) == {"kind": "struct", "fields": [
        {"name": "x", "type": {"kind": "int"}},
        {"name": "y", "type": {"kind": "array", "element": {"kind": "nullable", "inner": {"kind": "int"}}}},
        {"name": "z", "type": {"kind": "int"}},
    ]}


@pytest.mark.parametrize("annotation,path", [
    (list[Annotated[dict[str, int], Field(description="unsupported")]], "$.x[]"),
    (list[list[Annotated[dict[str, int], Field(description="unsupported")]]], "$.x[][]"),
])
def test_annotated_unsupported_inner_type_keeps_path(annotation, path):
    model = create_model("Unsupported", x=(annotation, ...))
    with pytest.raises(UnsupportedSchemaError) as err:
        to_ir(model)
    assert err.value.code == "unsupported"
    assert err.value.path == path


@pytest.mark.parametrize("wire_name,message", [
    ("", "field names must be non-empty"),
    (_WireName("wire"), "field names must be strings"),
    (_WireName(""), "field names must be strings"),
    ("__proto__", 'field name "__proto__" is not portable'),
    ("0", 'field name "0" is an array index and would reorder as an object key'),
    ("4294967294", 'field name "4294967294" is an array index and would reorder as an object key'),
    ("\ud800", "field name contains a lone surrogate and has no portable encoding"),
    ("\udfff", "field name contains a lone surrogate and has no portable encoding"),
])
@pytest.mark.parametrize("annotation", [int, dict[str, int]])
@pytest.mark.parametrize("convert", [to_ir, compile])
def test_nonportable_field_names_fail_with_adapter_path(wire_name, message, annotation, convert):
    model = create_model("BadName", __config__=ConfigDict(defer_build=True), x=(annotation, Field(alias=wire_name)))
    with pytest.raises(UnsupportedSchemaError) as err:
        convert(model)
    assert err.value.code == "unsupported"
    assert err.value.path == "$.x"
    assert str(err.value) == f"$.x: {message}"


@pytest.mark.parametrize("wire_name", [0, False, b"wire"])
@pytest.mark.parametrize("convert", [to_ir, compile])
def test_non_string_wire_names_fail_with_adapter_path(wire_name, convert):
    model = create_model("BadName", __config__=ConfigDict(defer_build=True), x=(int, ...))
    info = model.model_fields["x"]
    info.alias = info.serialization_alias = wire_name
    with pytest.raises(UnsupportedSchemaError) as err:
        convert(model)
    assert err.value.code == "unsupported"
    assert err.value.path == "$.x"
    assert str(err.value) == "$.x: field names must be strings"


def test_nonportable_nested_field_name_keeps_adapter_path():
    class Inner(BaseModel):
        x: int = Field(alias="0")

    class Outer(BaseModel):
        rows: list[Inner]

    with pytest.raises(UnsupportedSchemaError) as err:
        to_ir(Outer)
    assert err.value.path == "$.rows[].x"


@pytest.mark.parametrize("annotation,node,rejects_constraint", [
    (list[Annotated[float, Ge(0)]], {"kind": "array", "element": {"kind": "float64"}}, False),
    (list[Annotated[str, Ge(0)]], {"kind": "array", "element": {"kind": "string"}}, False),
    (list[Annotated[list[int], Ge(0)]],
     {"kind": "array", "element": {"kind": "array", "element": {"kind": "int"}}}, PYDANTIC_VERSION < (2, 9)),
    (list[Annotated[_Nested, Ge(0)]],
     {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "n", "type": {"kind": "int"}}]}}, False),
    (list[Annotated[_Tag, Ge(0)]], {"kind": "array", "element": {"kind": "enum", "members": ["a", "b"]}}, False),
])
def test_nested_bounds_only_apply_to_int_nodes(annotation, node, rejects_constraint):
    if rejects_constraint:
        with pytest.raises(TypeError, match=r"constraints cannot be applied to list\[int\]: 'ge'"):
            create_model("Constrained", x=(annotation, ...))
        model = create_model("Constrained", __config__=ConfigDict(defer_build=True), x=(annotation, ...))
    else:
        model = create_model("Constrained", x=(annotation, ...))
    assert to_ir(model) == {"kind": "struct", "fields": [{"name": "x", "type": node}]}


@pytest.mark.parametrize("convert", [to_ir, compile])
def test_duplicate_wire_names_fail_with_adapter_path(convert):
    class Duplicate(BaseModel):
        x: int = Field(alias="wire")
        y: int = Field(alias="wire")

    class Outer(BaseModel):
        nested: Duplicate

    with pytest.raises(UnsupportedSchemaError) as err:
        convert(Outer)
    assert err.value.code == "unsupported"
    assert err.value.path == "$.nested.y"
    assert str(err.value) == '$.nested.y: duplicate field "wire"'


@pytest.mark.parametrize("wire_name", ["00", "01", "-1", "1.0", "4294967295", "9" * 5000, "١", "😀", "constructor"])
def test_portable_wire_names_keep_ir_and_artifacts(wire_name):
    model = create_model("Portable", x=(int, Field(alias=wire_name)))
    expected = {"kind": "struct", "fields": [{"name": wire_name, "type": {"kind": "int"}}]}
    assert to_ir(model) == expected
    codec = compile(model, validate=True)
    reference = compile_ir(expected)
    assert codec.artifact == reference.artifact
    assert codec.fingerprint == reference.fingerprint
    assert codec.encode({wire_name: 2}) == reference.encode({wire_name: 2})
    assert codec.decode(codec.encode({wire_name: 2})).x == 2


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
