import math

import pytest

from hyperfly import EncodeError, compile_ir


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
