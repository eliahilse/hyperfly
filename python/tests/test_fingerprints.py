import pytest

from conftest import load
from hyperfly import compile_ir, fingerprint_of, serialize_artifact

CASES = load("fingerprints.json")["cases"]


def test_fingerprints_match_reference():
    assert CASES, "fingerprint vectors missing"
    for case in CASES:
        canonical = serialize_artifact(case["ir"], case["plan"], case.get("profile"))
        assert canonical == case["canonical"], case["name"]
        assert fingerprint_of(canonical).hex() == case["fingerprint"], case["name"]


def _flagged(**flags):
    return {"kind": "struct", "fields": [{"name": "x", "type": {"kind": "bool"}, **flags}]}


@pytest.mark.parametrize(
    ("value", "truthy"),
    [(None, False), (0, False), (0.0, False), ("", False), (1, True), ("no", True), ([], True), ({}, True)],
)
def test_field_flags_read_with_reference_truthiness(value, truthy):
    for flag in ("optional", "nullable"):
        codec = compile_ir(_flagged(**{flag: value}))
        expected = compile_ir(_flagged(**{flag: True}) if truthy else _flagged())
        assert codec.fingerprint == expected.fingerprint
        assert codec.encode({"x": True}) == expected.encode({"x": True})
        assert codec.ir["fields"][0][flag] is truthy
