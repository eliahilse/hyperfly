import base64
import json
import math
from pathlib import Path
import zlib

import pytest

from hyperfly import compile_ir, train
from hyperfly._ir import MAX_DICT_ENTRIES

ROWS = {
    "kind": "array",
    "element": {"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]},
}
PAIR = {
    "kind": "array",
    "element": {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": {"kind": "string"}},
            {"name": "b", "type": {"kind": "string"}, "optional": True},
        ],
    },
}
FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "train_parity.json").read_text())


def samples(values):
    return [[{"s": value} for value in batch] for batch in values]


def columns(profile):
    return profile["shared"]["columns"] if profile is not None else []


def test_keeps_repeated_values_and_drops_one_offs():
    profile = train(ROWS, samples([["alpha", "alpha"], ["alpha", "beta"], ["beta", "unique"]]))
    assert columns(profile) == [{"leaf": 0, "dict": ["alpha", "beta"]}]


def test_returns_nothing_without_repetition():
    assert train(ROWS, samples([["a"], ["b"], ["c"]])) is None


def test_orders_by_frequency():
    profile = train(ROWS, samples([["rare", "rare", "common", "common", "common", "common"]]))
    assert columns(profile)[0]["dict"][0] == "common"


def test_profile_shrinks_held_out_data_and_round_trips():
    profile = train(ROWS, samples([["online", "offline", "online"], ["online", "online", "degraded"]]))
    bare = compile_ir(ROWS, plan="columnar", pack=False)
    profiled = compile_ir(ROWS, plan="columnar", profile=profile, pack=False)
    holdout = [{"s": "online"}, {"s": "offline"}, {"s": "novel"}]
    encoded = profiled.encode_body(holdout)
    assert len(encoded) < len(bare.encode_body(holdout))
    assert profiled.decode_body(encoded) == holdout


def test_output_compiles_at_entry_ceiling():
    many = [f"v{i}" for i in range(MAX_DICT_ENTRIES + 50)]
    profile = train(ROWS, samples([many, many]))
    assert len(columns(profile)[0]["dict"]) <= MAX_DICT_ENTRIES
    compile_ir(ROWS, plan="columnar", profile=profile)


def test_nested_and_multi_array_ordinals():
    ir = {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": ROWS},
            {"name": "b", "type": {
                "kind": "array", "element": {"kind": "struct", "fields": [
                    {"name": "inner", "type": {"kind": "struct", "fields": [
                        {"name": "t", "type": {"kind": "string"}},
                    ]}},
                ]},
            }},
        ],
    }
    sample = {"a": [{"s": "aa"}, {"s": "aa"}], "b": [{"inner": {"t": "bb"}}, {"inner": {"t": "bb"}}]}
    profile = train(ir, [sample, sample])
    assert columns(profile) == [{"leaf": 0, "dict": ["aa"]}, {"leaf": 1, "dict": ["bb"]}]
    codec = compile_ir(ir, plan="columnar", profile=profile, pack=False)
    assert codec.decode_body(codec.encode_body(sample)) == sample


def test_skips_lone_surrogates():
    profile = train(ROWS, samples([["\ud800x", "\ud800x"], ["ok", "ok"], ["\udfff", "\udfff"]]))
    assert columns(profile)[0]["dict"] == ["ok"]


def test_induces_through_all_letter_hex_segment():
    profile = train(ROWS, samples([["id_00af", "id_beef"], ["id_cafe", "id_12ff"]]))
    assert columns(profile)[0]["grammar"] == [
        {"lit": "id_"}, {"num": {"base": 16, "len": 4, "case": "lower"}},
    ]
    codec = compile_ir(ROWS, plan="columnar", profile=profile, pack=False)
    holdout = [{"s": "id_0123"}, {"s": "id_dead"}, {"s": "id_zzzz"}]
    assert codec.decode_body(codec.encode_body(holdout)) == holdout


def test_mixed_case_slot_has_no_grammar():
    profile = train(ROWS, samples([["id_00AF", "id_00af"], ["id_12Ff", "id_34aa"]]))
    assert all("grammar" not in column for column in columns(profile))


def test_constant_slot_becomes_literal():
    profile = train(ROWS, samples([["v2-0001-x", "v2-0002-x"], ["v2-0003-x", "v2-0004-x"]]))
    assert columns(profile)[0]["grammar"] == [
        {"lit": "v2-"}, {"num": {"base": 10, "len": 4, "case": "lower"}}, {"lit": "-x"},
    ]


def test_derivation_observes_every_source_entry():
    rows = [[{"a": "u1", "b": "kim@x.io"}, {"a": "u2", "b": "lee@x.io"}]] * 2
    profile = train(PAIR, rows)
    derived = next(column["derived"] for column in columns(profile) if "derived" in column)
    assert derived == {"source": 0, "values": ["kim@x.io", "lee@x.io"]}
    codec = compile_ir(PAIR, plan="columnar", profile=profile, pack=False)
    assert codec.decode_body(codec.encode_body(rows[0])) == rows[0]


def test_unobserved_source_blocks_derivation():
    rows = [[{"a": "u1", "b": "kim@x.io"}, {"a": "u2"}]] * 2
    assert all("derived" not in column for column in columns(train(PAIR, rows)))


def test_contradicted_mapping_blocks_derivation():
    rows = [
        [{"a": "u1", "b": "kim@x.io"}, {"a": "u1", "b": "other@x.io"}],
        [{"a": "u1", "b": "kim@x.io"}, {"a": "u1", "b": "kim@x.io"}],
    ]
    assert all("derived" not in column for column in columns(train(PAIR, rows)))


@pytest.mark.parametrize("case", FIXTURES, ids=lambda case: case["name"])
def test_typescript_parity(case):
    encoded = case["samples"]
    assert encoded["encoding"] == "deflate-raw-base64"
    values = json.loads(zlib.decompress(base64.b64decode(encoded["data"]), -15))
    if case["name"] in ("devices", "candles", "feed"):
        assert len(values) == 60
    options = case["options"]
    profile = train(
        case["ir"], values,
        min_occurrences=options.get("minOccurrences", 2),
        max_entries=options.get("maxEntries", MAX_DICT_ENTRIES),
    )
    assert profile == case["profile"]
    assert json.dumps(profile, ensure_ascii=False, separators=(",", ":")) == json.dumps(
        case["profile"], ensure_ascii=False, separators=(",", ":")
    )
    assert compile_ir(case["ir"], plan="columnar", profile=profile).fingerprint == case["fingerprint"]



def test_utf8_frequency_ties():
    profile = train(ROWS, samples([["\U00010000", "\ue000", "é", "a"]] * 2))
    assert columns(profile)[0]["dict"] == ["a", "é", "\ue000", "\U00010000"]


@pytest.mark.parametrize("options,expected", [
    ({"max_entries": 1.9}, ["alpha"]),
    ({"max_entries": -0.0}, None),
    ({"max_entries": -1}, None),
    ({"max_entries": math.nan}, None),
    ({"max_entries": math.inf}, ["alpha", "beta"]),
    ({"min_occurrences": 3.9}, ["alpha"]),
    ({"min_occurrences": -math.inf}, ["alpha", "beta"]),
    ({"min_occurrences": math.inf}, None),
    ({"min_occurrences": math.nan}, None),
])
def test_option_rounding_and_clamping(options, expected):
    profile = train(ROWS, samples([["alpha", "alpha", "alpha", "beta", "beta"]]), **options)
    assert (columns(profile)[0]["dict"] if profile else None) == expected


@pytest.mark.parametrize("ir,values", [
    (ROWS, []),
    (ROWS, [None, {}, [None, {}, {"s": 12}, {"s": True}]]),
    ({"kind": "array", "element": {"kind": "string"}}, [["aa", "aa"]]),
    ({"kind": "struct", "fields": [{"name": "s", "type": {"kind": "string"}}]}, [{"s": "aa"}] * 2),
])
def test_empty_and_non_columnar_values(ir, values):
    assert train(ir, values) is None


def test_nested_arrays_and_nullable_wrappers():
    ir = {"kind": "nullable", "inner": {"kind": "array", "element": ROWS}}
    profile = train(ir, [None, samples([["alpha", "alpha"], ["alpha", "beta"]])])
    assert columns(profile) == [{"leaf": 0, "dict": ["alpha"]}]


def test_derivation_chooses_lowest_source_ordinal():
    ir = {"kind": "array", "element": {"kind": "struct", "fields": [
        {"name": name, "type": {"kind": "string"}} for name in ("a", "b", "c")
    ]}}
    profile = train(ir, [[{"a": "u1", "b": "v1", "c": "target"}]] * 2)
    assert columns(profile)[2]["derived"] == {"source": 0, "values": ["target"]}


def test_source_escape_blocks_derivation():
    profile = train(PAIR, [[{"a": "u1", "b": "known"}, {"a": "u1", "b": "known"}, {"a": "u2", "b": "other"}]])
    assert all("derived" not in column for column in columns(profile))
