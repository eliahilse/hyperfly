from pathlib import Path

import pytest


def test_package_is_strict_mypy_clean(tmp_path):
    pytest.importorskip("mypy")
    from mypy import api

    project = Path(__file__).resolve().parents[1]
    usage = tmp_path / "usage.py"
    usage.write_text('''
from typing import Any
from pydantic import BaseModel
from hyperfly import Codec, CodecRegistry, PackHooks, compile_ir, validate_profile
from hyperfly.http import Negotiation, decode_request, decode_response, encode_for, negotiate
from hyperfly.pydantic import ModelCodec, compile

class Flag(BaseModel):
    on: bool

ir: dict[str, Any] = {"kind": "bool"}
hooks: PackHooks = {"deflate": lambda data: data, "inflate": lambda data, size: data}
codec = Codec[bool](ir, pack=hooks)
encoded: bytes = codec.encode(True)
value: bool = codec.decode(memoryview(encoded))
body_value: bool = codec.decode_body(bytearray(codec.encode_body(value)))
plain: Codec[Any] = compile_ir(ir, pack=False)
model_codec: ModelCodec = compile(Flag, validate=True, pack=hooks)
base: Codec[Any] = model_codec
registry = CodecRegistry([codec, plain, model_codec])
registry.add(model_codec)
decision: Negotiation = negotiate(model_codec.fingerprint, registry)
body, headers = encode_for(decision, Flag(on=True))
decode_response(headers["Content-Type"], body, registry)
decode_request(headers["Content-Type"], model_codec.fingerprint, body, registry)
validate_profile(ir, {"version": 1, "shared": {"columns": []}})
''')
    stdout, stderr, status = api.run([
        "--config-file", str(project / "pyproject.toml"),
        str(project / "src" / "hyperfly"), str(usage),
    ])
    assert status == 0, stdout + stderr
