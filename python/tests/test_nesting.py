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


def nested_value(levels, value):
    for _ in range(levels):
        value = [value]
    return value


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
    assert (err.value.code, str(err.value)) == ("ir", "artifact nests deeper than 512")


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


def test_nesting_counts_from_the_artifact_whatever_the_path():
    with pytest.raises(HyperflyError) as err:
        validate_ir(array_chain(DEEPEST + 1), "$.items")
    assert str(err.value) == "artifact nests deeper than 512"


def test_cyclic_ir_is_rejected_before_any_walk():
    ir = {"kind": "array"}
    ir["element"] = ir
    for entry in ("validate_ir", "compile_row", "serialize_node"):
        with pytest.raises(HyperflyError) as err:
            ir_entry_points(ir)[entry]()
        assert (err.value.code, str(err.value)) == ("ir", "artifact nests deeper than 512")


def frame_sweep():
    """Caller depths from none to just short of the recursion limit."""
    return range(0, sys.getrecursionlimit() - 60, 40)


@pytest.mark.parametrize("chain", sorted(CHAINS))
def test_validators_and_serializers_work_at_any_caller_depth(chain):
    ir = CHAINS[chain](DEEPEST)
    node, artifact = serialize_node(ir), serialize_artifact(ir, "columnar")
    for frames in frame_sweep():
        at_depth(frames, lambda: validate_ir(ir))
        assert at_depth(frames, lambda: serialize_node(ir)) == node
        assert at_depth(frames, lambda: serialize_artifact(ir, "columnar")) == artifact


def outcome(frames, fn):
    try:
        at_depth(frames, fn)
    except HyperflyError as error:
        return error.code
    return "ok"


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_compile_and_train_past_the_stack_are_ir_errors(plan):
    ir = array_chain(DEEPEST)
    outcomes = {outcome(frames, lambda: compile_ir(ir, plan=plan)) for frames in frame_sweep()}
    outcomes |= {outcome(frames, lambda: train(ir, [[]])) for frames in frame_sweep()}
    assert outcomes == {"ok", "ir"}


def struct_rows(levels):
    ir, value = {"kind": "int"}, 7
    for _ in range(levels):
        ir, value = {"kind": "struct", "fields": [{"name": "a", "type": ir}]}, {"a": value}
    return {"kind": "array", "element": ir}, [value]


@pytest.mark.parametrize("plan", ["row", "columnar"])
def test_encode_and_decode_past_the_stack_are_depth_errors(plan):
    ir, value = struct_rows(160)
    codec = compile_ir(ir, plan=plan, limits=dataclasses.replace(Limits(), max_depth=1000))
    body = codec.encode_body(value)
    assert codec.decode_body(body) == value
    encoded = {outcome(frames, lambda: codec.encode_body(value)) for frames in frame_sweep()}
    decoded = {outcome(frames, lambda: codec.decode_body(body)) for frames in frame_sweep()}
    assert decoded == {"ok", "depth"}
    assert encoded == ({"ok", "depth"} if plan == "row" else {"ok"})


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


TWO_STRINGS = {"kind": "array", "element": {"kind": "struct", "fields": [
    {"name": "a", "type": {"kind": "string"}}, {"name": "b", "type": {"kind": "string"}},
]}}
DEEPEST_PROFILE = {"version": 2, "shared": {"columns": [
    {"leaf": 0, "dict": ["id_01"], "grammar": [{"lit": "id_"}, {"num": {"base": 10, "len": 2, "case": "lower"}}]},
    {"leaf": 1, "derived": {"source": 0, "values": ["one"]}},
]}}


def test_profiles_at_their_deepest_canonical_shape_work_with_ir_at_the_cap():
    ir = array_chain(507, TWO_STRINGS)
    value = nested_value(506, [{"a": "id_01", "b": "one"}])
    validate_profile(ir, DEEPEST_PROFILE)
    limits = dataclasses.replace(Limits(), max_depth=512)
    codec = compile_ir(ir, plan="columnar", profile=DEEPEST_PROFILE, limits=limits, pack=False)
    assert json_depth(json.loads(codec.artifact)) == 512
    assert codec.artifact == serialize_artifact(ir, "columnar", DEEPEST_PROFILE)
    assert codec.decode(codec.encode(value)) == value
    assert train(ir, [value, value]) is not None
    deeper = {"kind": "array", "element": ir}
    for check in (
        lambda: compile_ir(deeper, plan="columnar", profile=DEEPEST_PROFILE),
        lambda: validate_profile(deeper, DEEPEST_PROFILE),
        lambda: serialize_artifact(deeper, "columnar", DEEPEST_PROFILE),
        lambda: train(deeper, []),
    ):
        with pytest.raises(HyperflyError) as err:
            check()
        assert (err.value.code, str(err.value)) == ("ir", "artifact nests deeper than 512")


@pytest.mark.parametrize("frames", [0, 100])
@pytest.mark.parametrize("levels", [512, 513, 20_000])
def test_advisory_hints_nest_to_any_depth(levels, frames):
    baseline = compile_ir(ROWS, plan="columnar", profile=PROFILE)
    profile = deep_hints(levels)
    at_depth(frames, lambda: validate_profile(ROWS, profile))
    codec = at_depth(frames, lambda: compile_ir(ROWS, plan="columnar", profile=profile))
    assert codec.fingerprint == baseline.fingerprint
    assert codec.artifact == serialize_artifact(ROWS, "columnar", profile)
    copy = codec.profile["hints"]
    assert copy is not profile["hints"]
    for _ in range(levels - 2):
        copy = copy["x"]
    assert copy == {}


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


def test_the_ir_is_checked_before_the_profile():
    with pytest.raises(HyperflyError) as err:
        validate_profile({"kind": "nope"}, {**PROFILE, "hints": {"x": math.nan}})
    assert str(err.value) == "$: unknown IR kind nope"


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


def recursive_node_json(node):
    """The recursive canonical serializer the iterative one replaced, kept as a reference."""
    kind = node["kind"]
    if kind in ("bool", "float64", "string", "bytes"):
        return '{"kind":"' + kind + '"}'
    if kind == "int":
        out = '{"kind":"int"'
        if node.get("min") is not None:
            out += f',"min":{int(node["min"])}'
        if node.get("max") is not None:
            out += f',"max":{int(node["max"])}'
        return out + "}"
    if kind == "literal":
        value = node["value"]
        text = "null" if value is None else "true" if value is True else "false" if value is False else (
            str(int(value)) if type(value) in (int, float) else json.dumps(value, ensure_ascii=False)
        )
        return f'{{"kind":"literal","value":{text}}}'
    if kind == "enum":
        return '{"kind":"enum","members":[' + ",".join(json.dumps(m, ensure_ascii=False) for m in node["members"]) + "]}"
    if kind == "nullable":
        return f'{{"kind":"nullable","inner":{recursive_node_json(node["inner"])}}}'
    if kind == "array":
        out = f'{{"kind":"array","element":{recursive_node_json(node["element"])}'
        if node.get("length") is not None:
            out += f',"length":{int(node["length"])}'
        return out + "}"
    fields = []
    for f in node["fields"]:
        text = f'{{"name":{json.dumps(f["name"], ensure_ascii=False)},"type":{recursive_node_json(f["type"])}'
        if f.get("optional"):
            text += ',"optional":true'
        if f.get("nullable"):
            text += ',"nullable":true'
        fields.append(text + "}")
    return '{"kind":"struct","fields":[' + ",".join(fields) + "]}"


def fixture_irs():
    from conftest import load

    found = []
    stack = [load(name) for name in ("vectors.json", "columnar.json", "ir.json", "limits.json", "fingerprints.json")]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if isinstance(item.get("ir"), dict):
                found.append(item["ir"])
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    valid = []
    for ir in found:
        try:
            validate_ir(ir)
        except HyperflyError:
            continue
        valid.append(ir)
    return valid


MIXED = {"kind": "struct", "fields": [
    {"name": "i", "type": {"kind": "int", "min": -3.0, "max": 9}, "optional": True},
    {"name": "l", "type": {"kind": "literal", "value": "q\"\\\u0001é"}},
    {"name": "n", "type": {"kind": "nullable", "inner": {"kind": "array", "element": {"kind": "bytes"}, "length": 2}}},
    {"name": "e", "type": {"kind": "enum", "members": ("a", "\u2028")}, "nullable": True, "optional": True},
    {"name": "z", "type": {"kind": "literal", "value": -0.0}},
    {"name": "s", "type": {"kind": "struct", "fields": ()}},
]}


def test_iterative_serializer_matches_the_recursive_one():
    irs = fixture_irs() + [MIXED, array_chain(DEEPEST), struct_chain(DEEPEST), array_chain(DEEPEST - json_depth(MIXED) + 1, MIXED)]
    assert len(irs) > 100
    for ir in irs:
        assert serialize_node(ir) == recursive_node_json(ir)


def test_ir_copies_keep_tuples_and_plain_dicts():
    import copy

    class Node(dict):
        pass

    shared = Node(kind="enum", members=("a", "b"))
    ir = {"kind": "struct", "fields": (
        {"name": "x", "type": shared},
        {"name": "y", "type": {"kind": "array", "element": shared}},
    )}
    codec = compile_ir(ir)
    for copied in (codec.ir, codec.ir):
        assert copied == copy.deepcopy(ir)
        assert type(copied["fields"]) is tuple
        x, y = copied["fields"]
        assert type(x["type"]) is dict and type(x["type"]["members"]) is tuple
        assert x["type"] is y["type"]["element"]
        assert x["type"] is not shared
    assert codec.encode_body({"x": "b", "y": ["a"]}) == compile_ir(copy.deepcopy(ir)).encode_body({"x": "b", "y": ["a"]})
