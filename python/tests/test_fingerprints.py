from conftest import load
from hyperfly import compile_ir, fingerprint_of, serialize_artifact

CASES = load("fingerprints.json")["cases"]


def test_fingerprints_match_reference():
    assert CASES, "fingerprint vectors missing"
    for case in CASES:
        canonical = serialize_artifact(case["ir"], case["plan"], case.get("profile"))
        assert canonical == case["canonical"], case["name"]
        assert fingerprint_of(canonical).hex() == case["fingerprint"], case["name"]


def test_explicit_false_flags_canonicalize_away():
    bare = {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "bool"}}]}
    explicit = {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "bool"}, "optional": False, "nullable": False}]}
    assert serialize_artifact(explicit, "row") == serialize_artifact(bare, "row")
    assert compile_ir(explicit).fingerprint == compile_ir(bare).fingerprint


def test_tuple_members_and_fields_compile_like_lists():
    listed = {"kind": "struct", "fields": [{"name": "e", "type": {"kind": "enum", "members": ["a", "b"]}}]}
    tupled = {"kind": "struct", "fields": ({"name": "e", "type": {"kind": "enum", "members": ("a", "b")}},)}
    assert compile_ir(tupled).fingerprint == compile_ir(listed).fingerprint
