import collections
import dataclasses
import json
import math
import sys

import pytest

from hyperfly import (
    Codec,
    HyperflyError,
    Limits,
    compile_ir,
    serialize_artifact,
    serialize_node,
    train,
    validate_ir,
    validate_profile,
)

ROWS = {"kind": "array", "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}}
PROFILE = {"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["a"]}]}}


def array_chain(levels, leaf=None):
    """IR whose JSON nests exactly `levels` deep: one level per array node."""
    ir = leaf or {"kind": "bool"}
    for _ in range(levels - 1):
        ir = {"kind": "array", "element": ir}
    return ir


def struct_chain(levels):
    """IR whose JSON nests exactly `levels` deep: a struct, its fields and a field are three levels."""
    ir = {"kind": "bool"}
    depth = 1
    while depth + 3 <= levels:
        ir = {"kind": "struct", "fields": [{"name": "a", "type": ir}]}
        depth += 3
    return array_chain(levels - depth + 1, ir)


def json_depth(value):
    if isinstance(value, dict):
        return 1 + max(map(json_depth, value.values()), default=0)
    if isinstance(value, list):
        return 1 + max(map(json_depth, value), default=0)
    return 0


def deep_hints(levels):
    """A profile document whose JSON nests exactly `levels` deep through its hints."""
    hints = {}
    for _ in range(levels - 2):
        hints = {"x": hints}
    return {**PROFILE, "hints": hints}


def at_depth(frames, fn):
    return at_depth(frames - 1, fn) if frames else fn()


CHAINS = {"array": array_chain, "struct": struct_chain}
DEEPEST = 511  # the artifact object wraps the IR, so 511 IR levels nest the artifact 512 deep


@pytest.mark.parametrize("chain", sorted(CHAINS))
def test_chains_nest_exactly(chain):
    assert json_depth(CHAINS[chain](DEEPEST + 1)) == DEEPEST + 1
    ir = CHAINS[chain](DEEPEST)
    assert json_depth(ir) == DEEPEST
    assert json_depth(json.loads(serialize_artifact(ir))) == 512


def ir_entry_points(ir):
    return {
        "validate_ir": lambda: validate_ir(ir),
        "compile_row": lambda: compile_ir(ir).ir,
        "compile_columnar": lambda: compile_ir(ir, plan="columnar").ir,
        "Codec": lambda: Codec(ir).artifact,
        "validate_profile": lambda: validate_profile(ir, PROFILE),
        "train": lambda: train(ir, []),
        "serialize_node": lambda: serialize_node(ir),
        "serialize_artifact": lambda: serialize_artifact(ir, "columnar"),
    }


ENTRY_POINTS = sorted(ir_entry_points(None))


@pytest.mark.parametrize("frames", [0, 100])
@pytest.mark.parametrize("entry", ENTRY_POINTS)
@pytest.mark.parametrize("chain", sorted(CHAINS))
def test_artifact_nested_512_deep_is_accepted(chain, entry, frames):
    ir = CHAINS[chain](DEEPEST)
    if entry == "validate_profile":
        with pytest.raises(HyperflyError, match="^profile: leaf 0 is not a "):
            at_depth(frames, ir_entry_points(ir)[entry])
        return
    at_depth(frames, ir_entry_points(ir)[entry])


@pytest.mark.parametrize("frames", [0, 100])
@pytest.mark.parametrize("entry", ENTRY_POINTS)
@pytest.mark.parametrize("chain", sorted(CHAINS))
def test_artifact_nested_513_deep_is_rejected(chain, entry, frames):
    with pytest.raises(HyperflyError) as err:
        at_depth(frames, ir_entry_points(CHAINS[chain](DEEPEST + 1))[entry])
    assert (err.value.code, str(err.value)) == ("ir", "$: artifact nests deeper than 512")


@pytest.mark.parametrize("leaf", [
    {"kind": "enum", "members": ["a"]},
    {"kind": "struct", "fields": []},
    {"kind": "struct", "fields": [{"name": "a", "type": {"kind": "int", "min": 1.0}}]},
])
def test_nesting_counts_the_canonical_containers(leaf):
    ir = array_chain(DEEPEST - json_depth(leaf) + 1, leaf)
    assert json_depth(json.loads(compile_ir(ir).artifact)) == 512
    with pytest.raises(HyperflyError, match="artifact nests deeper than 512"):
        validate_ir({"kind": "array", "element": ir})


def test_nesting_ignores_input_the_artifact_drops():
    with pytest.raises(HyperflyError) as err:
        validate_ir({"kind": "bool", "extra": array_chain(2000)})
    assert str(err.value) == "$: unknown key extra"


def test_nesting_path_follows_the_caller():
    with pytest.raises(HyperflyError) as err:
        validate_ir(array_chain(DEEPEST + 1), "$.items")
    assert str(err.value) == "$.items: artifact nests deeper than 512"


def test_cyclic_ir_is_rejected_before_any_walk():
    ir = {"kind": "array"}
    ir["element"] = ir
    for entry in ("validate_ir", "compile_row", "serialize_node"):
        with pytest.raises(HyperflyError) as err:
            ir_entry_points(ir)[entry]()
        assert (err.value.code, str(err.value)) == ("ir", "$: artifact nests deeper than 512")


def test_validate_ir_never_leaks_recursion_errors():
    ir = array_chain(DEEPEST)
    with pytest.raises(HyperflyError) as err:
        at_depth(sys.getrecursionlimit() - 150, lambda: validate_ir(ir))
    assert err.value.code == "ir"


def test_deep_ir_copies_survive_the_compiled_codec():
    ir = array_chain(DEEPEST)
    codec = compile_ir(ir, plan="columnar")
    assert codec.ir == ir
    assert compile_ir(codec.ir, plan="columnar").fingerprint == codec.fingerprint


def test_shared_ir_nodes_stay_shared_in_the_copy():
    leaf = {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "int"}}]}
    ir = {"kind": "struct", "fields": [{"name": "a", "type": leaf}, {"name": "b", "type": leaf}]}
    copy = compile_ir(ir).ir
    assert copy == ir
    assert copy["fields"][0]["type"] is copy["fields"][1]["type"]
    assert copy["fields"][0]["type"] is not leaf


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_deep_values_encode_under_a_raised_max_depth(plan):
    limits = dataclasses.replace(Limits(), max_depth=600)
    codec = compile_ir(array_chain(501, {"kind": "int"}), plan=plan, limits=limits)
    value = 7
    for _ in range(500):
        value = [value]
    body = at_depth(100, lambda: codec.encode_body(value))
    assert at_depth(100, lambda: codec.decode_body(body)) == value


def test_deep_values_past_the_stack_are_coded_errors():
    limits = dataclasses.replace(Limits(), max_depth=600)
    codec = compile_ir(array_chain(501, {"kind": "int"}), limits=limits)
    value = 7
    for _ in range(500):
        value = [value]
    body = codec.encode_body(value)
    frames = sys.getrecursionlimit() - 300
    with pytest.raises(HyperflyError) as err:
        at_depth(frames, lambda: codec.encode_body(value))
    assert err.value.code == "depth"
    with pytest.raises(HyperflyError) as err:
        at_depth(frames, lambda: codec.decode_body(body))
    assert err.value.code == "depth"


@pytest.mark.parametrize("frames", [0, 100])
@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_profile_nested_512_deep_is_accepted(plan, frames):
    profile = deep_hints(512)
    assert json_depth(profile) == 512
    at_depth(frames, lambda: validate_profile(ROWS, profile))
    codec = at_depth(frames, lambda: compile_ir(ROWS, plan="columnar", profile=profile))
    assert codec.profile == profile


@pytest.mark.parametrize("frames", [0, 100])
def test_profile_nested_513_deep_is_rejected(frames):
    profile = deep_hints(513)
    for check in (lambda: validate_profile(ROWS, profile), lambda: compile_ir(ROWS, plan="columnar", profile=profile)):
        with pytest.raises(HyperflyError) as err:
            at_depth(frames, check)
        assert (err.value.code, str(err.value)) == ("ir", "profile: nests deeper than 512")


def test_primitives_at_the_cap_do_not_count():
    profile = deep_hints(512)
    inner = profile["hints"]
    while inner:
        inner = inner["x"]
    inner["leaf"] = 1
    validate_profile(ROWS, profile)


class Opaque:
    pass


def cyclic_dict():
    hints = {}
    hints["self"] = hints
    return hints


def cyclic_list():
    hints = []
    hints.append({"x": hints})
    return {"list": hints}


@pytest.mark.parametrize("hints, message", [
    ({"x": math.nan}, "profile: must contain only JSON data"),
    ({"x": math.inf}, "profile: must contain only JSON data"),
    ({"x": [-math.inf]}, "profile: must contain only JSON data"),
    ({"x": Opaque()}, "profile: must contain only JSON data"),
    ({"x": b"bytes"}, "profile: must contain only JSON data"),
    ({"x": 1 + 2j}, "profile: must contain only JSON data"),
    ({"x": (1, 2)}, "profile: must contain only plain objects and arrays"),
    ({"x": {1, 2}}, "profile: must contain only plain objects and arrays"),
    ({"x": collections.OrderedDict(a=1)}, "profile: must contain only plain objects and arrays"),
    (cyclic_dict(), "profile: must not contain cycles"),
    (cyclic_list(), "profile: must not contain cycles"),
    ({1: "a"}, "profile: JSON keys must be strings"),
    ({"x": {None: "a"}}, "profile: JSON keys must be strings"),
])
@pytest.mark.parametrize("entry", ["validate_profile", "compile_ir"])
def test_profile_must_be_json_data(hints, message, entry):
    profile = {**PROFILE, "hints": hints}
    with pytest.raises(HyperflyError) as err:
        if entry == "validate_profile":
            validate_profile(ROWS, profile)
        else:
            compile_ir(ROWS, plan="columnar", profile=profile)
    assert (err.value.code, str(err.value)) == ("ir", message)


@pytest.mark.parametrize("profile, message", [
    ({"version": 1.5, "shared": PROFILE["shared"]}, "profile: unsupported profile version (expected 1 or 2)"),
    ({"version": math.nan, "shared": PROFILE["shared"]}, "profile: must contain only JSON data"),
    ({"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ("a",)}]}}, "profile: must contain only plain objects and arrays"),
    ({"version": 1, "shared": {"columns": [{"leaf": 0, "dict": ["a"], 2: 3}]}}, "profile: JSON keys must be strings"),
    (("version", 1), "profile: must contain only plain objects and arrays"),
    (math.nan, "profile: must contain only JSON data"),
])
def test_whole_profile_document_is_json_data(profile, message):
    with pytest.raises(HyperflyError) as err:
        validate_profile(ROWS, profile)
    assert (err.value.code, str(err.value)) == ("ir", message)


def test_profile_json_data_is_checked_before_the_ir():
    with pytest.raises(HyperflyError) as err:
        validate_profile({"kind": "nope"}, {**PROFILE, "hints": {"x": math.nan}})
    assert str(err.value) == "profile: must contain only JSON data"


def test_json_hints_are_kept_and_isolated():
    hints = {"n": [1, -2.5, 0.0, True, None, "s", {"deep": []}], "big": 10**30}
    profile = {**PROFILE, "hints": hints}
    validate_profile(ROWS, profile)
    codec = compile_ir(ROWS, plan="columnar", profile=profile)
    hints["n"].append("later")
    assert codec.profile["hints"] == {"n": [1, -2.5, 0.0, True, None, "s", {"deep": []}], "big": 10**30}
    assert codec.profile["hints"] is not codec.profile["hints"]


def test_shared_profile_subtrees_are_not_cycles():
    shared = {"a": [1]}
    validate_profile(ROWS, {**PROFILE, "hints": {"x": shared, "y": shared, "z": [shared, shared]}})


def test_recursive_models_are_unsupported():
    pydantic = pytest.importorskip("pydantic")
    from hyperfly.pydantic import to_ir

    class Node(pydantic.BaseModel):
        value: int
        children: "list[Node]" = []

    with pytest.raises(HyperflyError) as err:
        to_ir(Node)
    assert err.value.code == "unsupported"
