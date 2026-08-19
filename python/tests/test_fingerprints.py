from conftest import load
from hyperfly import fingerprint_of, serialize_artifact

CASES = load("fingerprints.json")["cases"]


def test_fingerprints_match_reference():
    assert CASES, "fingerprint vectors missing"
    for case in CASES:
        canonical = serialize_artifact(case["ir"], case["plan"], case.get("profile"))
        assert canonical == case["canonical"], case["name"]
        assert fingerprint_of(canonical).hex() == case["fingerprint"], case["name"]
