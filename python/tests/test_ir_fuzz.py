import sys

import pytest
from hypothesis import example, given, settings, strategies as st

from hyperfly import Codec, HyperflyError, compile_ir


JSON = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats(allow_nan=False, allow_infinity=False) | st.text(),
    lambda children: st.lists(children, max_size=5) | st.dictionaries(st.text(), children, max_size=5),
    max_leaves=30,
)
KINDS = ("bool", "int", "float64", "string", "bytes", "enum", "literal", "nullable", "array", "struct", "junk")
IR_LIKE = st.fixed_dictionaries(
    {"kind": st.sampled_from(KINDS)},
    optional={
        key: JSON
        for key in ("element", "inner", "fields", "members", "value", "min", "max", "length", "name", "type", "optional", "nullable")
    },
)
FUZZ = settings(max_examples=300, deadline=None, database=None)


@pytest.mark.parametrize("plan", ["row", "columnar"])
@FUZZ
@given(ir=JSON | IR_LIKE, profile=JSON)
@example(ir=None, profile=None)
@example(ir={"kind": "array"}, profile=None)
@example(ir={"kind": "nullable"}, profile=None)
@example(ir={"kind": "literal"}, profile=None)
@example(ir={"kind": "struct"}, profile=None)
@example(ir={"kind": "struct", "fields": [{"name": "x"}]}, profile=None)
@example(ir={"kind": "struct", "fields": "x"}, profile=None)
@example(ir={"kind": "struct", "fields": [None]}, profile=None)
@example(ir={"kind": "enum", "members": 1}, profile=None)
@example(ir={"kind": "enum", "members": [1]}, profile=None)
@example(ir={"kind": "array", "element": []}, profile=None)
@example(ir={"kind": "nullable", "inner": []}, profile=None)
@example(ir={"kind": "int", "min": True}, profile=None)
@example(ir={"kind": []}, profile=None)
@example(ir={"kind": 10**5000}, profile=None)
@example(ir={"kind": "struct", "fields": [{"name": "x", "type": [], "nullable": True}]}, profile=None)
@example(ir={"kind": "struct", "fields": [{"name": "x", "type": {"kind": "bool"}, "optional": []}]}, profile=None)
def test_compile_json(ir, profile, plan):
    for candidate_profile in (None, profile):
        try:
            codec = compile_ir(ir, plan=plan, profile=candidate_profile)
        except HyperflyError:
            continue
        assert isinstance(codec, Codec)


PROFILE_IR = {
    "kind": "array",
    "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]},
}
PROFILE_LIKE = st.fixed_dictionaries(
    {"version": st.sampled_from([1, 2]), "shared": st.fixed_dictionaries({
        "columns": st.lists(st.fixed_dictionaries(
            {"leaf": st.just(0)}, optional={key: JSON for key in ("dict", "grammar", "derived")},
        ), max_size=3),
    })},
    optional={"hints": JSON},
)


@FUZZ
@given(profile=JSON | PROFILE_LIKE)
@example(profile={"version": 2, "shared": {"columns": [{"leaf": 0, "grammar": [{"num": {"base": [], "len": 1, "case": "lower"}}]}]}})
@example(profile={"version": 10**5000, "shared": {"columns": []}})
@example(profile={"version": 1, "shared": {"columns": [{"leaf": 10**5000, "dict": ["a"]}]}})
@example(profile={"version": 2, "shared": {"columns": [{"leaf": 0, "derived": {"source": 10**5000, "values": []}}]}})
def test_profile_json(profile):
    try:
        codec = compile_ir(PROFILE_IR, plan="columnar", profile=profile)
    except HyperflyError:
        return
    assert isinstance(codec, Codec)


@pytest.mark.parametrize("location", ["schema", "annotation", "hints"])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_deep_compilation(location, plan):
    nested = {"kind": "bool"}
    for _ in range(sys.getrecursionlimit() + 100):
        nested = {"kind": "array", "element": nested}
    ir = nested if location == "schema" else {**PROFILE_IR, "annotation": nested} if location == "annotation" else PROFILE_IR
    profile = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["a"]}]}, "hints": nested} if location == "hints" else None
    with pytest.raises(HyperflyError) as exc:
        compile_ir(ir, plan=plan, profile=profile)
    assert exc.value.code == "ir"


CASES = [
    ({"kind": "bool"}, st.booleans()),
    ({"kind": "int", "min": -100, "max": 100}, st.integers(-100, 100)),
    ({"kind": "float64"}, st.floats(allow_nan=False, allow_infinity=False)),
    ({"kind": "string"}, st.text()),
    ({"kind": "bytes"}, st.binary(max_size=30)),
    ({"kind": "enum", "members": ["a", "b", "c"]}, st.sampled_from(["a", "b", "c"])),
    ({"kind": "nullable", "inner": {"kind": "string"}}, st.none() | st.text()),
    ({"kind": "array", "element": {"kind": "int"}}, st.lists(st.integers(-1000, 1000), max_size=10)),
]
ROW = {"kind": "struct", "fields": [
    {"name": "s", "type": {"kind": "string"}},
    {"name": "i", "type": {"kind": "int"}},
    {"name": "f", "type": {"kind": "float64"}},
    {"name": "e", "type": {"kind": "enum", "members": ["a", "b", "c"]}},
    {"name": "n", "type": {"kind": "string"}, "optional": True, "nullable": True},
]}
ROW_VALUES = st.fixed_dictionaries(
    {"s": st.text(), "i": st.integers(-1000, 1000), "f": st.floats(allow_nan=False, allow_infinity=False), "e": st.sampled_from(["a", "b", "c"])},
    optional={"n": st.none() | st.text()},
)
CASES += [(ROW, ROW_VALUES), ({"kind": "array", "element": ROW}, st.lists(ROW_VALUES, max_size=10))]


@pytest.mark.parametrize("plan", ["row", "columnar"])
@FUZZ
@given(data=st.binary(max_size=256))
def test_decode_bytes(plan, data):
    for ir, _values in CASES:
        codec = compile_ir(ir, plan=plan)
        try:
            codec.decode_body(data)
        except HyperflyError:
            pass


@pytest.mark.parametrize("plan", ["row", "columnar"])
@FUZZ
@given(data=st.data())
def test_roundtrip(plan, data):
    ir, values = data.draw(st.sampled_from(CASES))
    codec = compile_ir(ir, plan=plan)
    value = data.draw(values)
    assert codec.decode_body(codec.encode_body(value)) == value
