import dataclasses
import math
from enum import IntEnum

import pytest
from pydantic import BaseModel

from hyperfly import EncodeError, HyperflyError, Limits, compile_ir
from hyperfly.pydantic import compile as compile_model


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("method", ["encode", "encode_body"])
@pytest.mark.parametrize("value,code", [
    (10**1000, "float"),
    (-(10**1000), "float"),
    (math.nan, "float"),
    (math.inf, "float"),
    (-math.inf, "float"),
    (True, "type"),
    ("1.5", "type"),
])
def test_float_errors(plan, method, value, code):
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "v", "type": {"kind": "float64"}}]}}
    codec = compile_ir(ir, plan=plan)
    with pytest.raises(EncodeError) as err:
        getattr(codec, method)([{"v": value}])
    assert err.value.code == code


@pytest.mark.parametrize("method", ["encode", "encode_body"])
def test_root_float_overflow(method):
    codec = compile_ir({"kind": "float64"})
    with pytest.raises(EncodeError) as err:
        getattr(codec, method)(10**1000)
    assert err.value.code == "float"


@pytest.mark.parametrize("plan", ["row", "columnar"])
@pytest.mark.parametrize("method", ["encode", "encode_body"])
def test_string_surrogate_errors(plan, method):
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "v", "type": {"kind": "string"}}]}}
    codec = compile_ir(ir, plan=plan)
    with pytest.raises(EncodeError) as err:
        getattr(codec, method)([{"v": "\ud800"}])
    assert err.value.code == "utf8"


@pytest.mark.parametrize("attribute", ["fingerprint", "artifact", "plan", "ir", "profile"])
def test_codec_metadata_is_read_only(attribute):
    codec = compile_ir({"kind": "string"})
    metadata = getattr(codec, attribute)
    wire = codec.encode("hello")
    with pytest.raises(AttributeError):
        setattr(codec, attribute, None)
    assert getattr(codec, attribute) == metadata
    assert wire[3:19].hex() == codec.fingerprint
    assert codec.decode(wire) == "hello"


BOOL_IR = {"kind": "bool"}
LIMIT_FIELDS = [field.name for field in dataclasses.fields(Limits)]


@pytest.mark.parametrize("field", LIMIT_FIELDS)
@pytest.mark.parametrize("value", [-1, 2**53, True, 1.0, "1", None])
def test_invalid_limit_values_are_options_errors(field, value):
    with pytest.raises(HyperflyError) as err:
        compile_ir(BOOL_IR, limits=dataclasses.replace(Limits(), **{field: value}))
    assert err.value.code == "options"
    assert str(err.value) == f"limits.{field}: must be a non-negative safe integer"


@pytest.mark.parametrize("field", LIMIT_FIELDS)
def test_limit_bounds_are_accepted(field):
    for value in (0, 2**53 - 1):
        compile_ir(BOOL_IR, limits=dataclasses.replace(Limits(), **{field: value}))


@pytest.mark.parametrize("options, message", [
    ({"limits": {"max_depth": 3}}, "limits: must be a Limits instance"),
    ({"plan": "rows"}, "plan: must be row or columnar"),
    ({"plan": None}, "plan: must be row or columnar"),
    ({"plan": ["row"]}, "plan: must be row or columnar"),
    ({"pack": True}, "pack: must be False or a mapping"),
    ({"pack": "zlib"}, "pack: must be False or a mapping"),
    ({"pack": {"deflate": 1}}, "pack.deflate: must be callable"),
    ({"pack": {"inflate": "zlib"}}, "pack.inflate: must be callable"),
])
def test_malformed_compile_options_are_options_errors(options, message):
    with pytest.raises(HyperflyError) as err:
        compile_ir(BOOL_IR, **options)
    assert (err.value.code, str(err.value)) == ("options", message)


def test_options_are_checked_before_the_ir():
    with pytest.raises(HyperflyError) as err:
        compile_ir(None, plan="rows")
    assert err.value.code == "options"


def test_unreadable_options_are_options_errors_with_a_cause():
    class Unreadable(dict):
        def get(self, *args):
            raise TypeError("unreadable")

    class Opaque(Limits):
        def __getattribute__(self, name):
            raise AttributeError(name)

    for options in ({"pack": Unreadable()}, {"limits": Opaque()}):
        with pytest.raises(HyperflyError) as err:
            compile_ir(None, **options)
        assert (err.value.code, str(err.value)) == ("options", "options: could not read compile options")
        assert isinstance(err.value.__cause__, (TypeError, AttributeError))


def test_options_are_read_once():
    class Flaky(dict):
        calls = 0

        def get(self, *args):
            self.calls += 1
            return None if self.calls <= 2 else 42

    class Growing(Limits):
        reads = 0

        def __getattribute__(self, name):
            if name == "max_items":
                type(self).reads += 1
                return 1 if type(self).reads == 1 else 100
            return super().__getattribute__(name)

    ir = {"kind": "array", "element": {"kind": "bool"}}
    compile_ir(ir, pack=Flaky()).encode_body([True])
    codec = compile_ir(ir, limits=Growing())
    with pytest.raises(EncodeError) as err:
        codec.encode_body([True, False])
    assert err.value.code == "limit"


def test_plan_and_limit_subclasses():
    class Plan(str):
        __hash__ = None

    assert compile_ir(BOOL_IR, plan=Plan("row")).encode_body(True) == compile_ir(BOOL_IR).encode_body(True)
    Bare = type("Bare", (Limits,), {"__dataclass_fields__": {}})
    with pytest.raises(HyperflyError) as err:
        compile_ir(BOOL_IR, limits=Bare(max_items=-1))
    assert err.value.code == "options"

    @dataclasses.dataclass(frozen=True)
    class Labelled(Limits):
        label: str = "route"

    compile_ir(BOOL_IR, limits=Labelled())
    Cap = IntEnum("Cap", {"ONE": 1})
    with pytest.raises(EncodeError):
        compile_ir({"kind": "array", "element": {"kind": "bool"}}, limits=Limits(max_items=Cap.ONE)).encode_body([True, True])


def test_well_formed_pack_options_compile():
    compile_ir(BOOL_IR, pack=False)
    compile_ir(BOOL_IR, pack={})
    compile_ir(BOOL_IR, pack={"deflate": None, "inflate": lambda data, size: data})


class Flag(BaseModel):
    on: bool


@pytest.mark.parametrize("options, message", [
    ({"validate": 1}, "validate: must be a boolean"),
    ({"validate": None}, "validate: must be a boolean"),
    ({"plan": "rows"}, "plan: must be row or columnar"),
    ({"limits": Limits(max_items=-1)}, "limits.max_items: must be a non-negative safe integer"),
])
def test_malformed_model_compile_options_are_options_errors(options, message):
    with pytest.raises(HyperflyError) as err:
        compile_model(Flag, **options)
    assert (err.value.code, str(err.value)) == ("options", message)
