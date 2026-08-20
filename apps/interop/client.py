"""A Python client speaking the negotiation protocol against the TypeScript server.

It starts with no artifacts, is offered one, fetches it, verifies the fingerprint it
derives matches the one it asked for, and only then speaks binary.
"""

from __future__ import annotations

import json
import sys
import urllib.request

from hyperfly import CodecRegistry, compile_ir
from hyperfly.http import accept_header, decode_response

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"


def get(path: str, accept: str | None = None) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(BASE + path)
    if accept:
        request.add_header("Hyperfly-Accept", accept)
    with urllib.request.urlopen(request) as response:
        return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()


def main() -> int:
    registry = CodecRegistry()

    status, headers, body = get("/v1/events")
    kind, value = decode_response(headers.get("content-type"), body, registry)
    assert kind == "json", kind
    offered = headers.get("hyperfly-offer")
    assert offered, "server should offer an artifact to a client that has none"
    json_bytes = len(body)
    print(f"1. no artifacts -> {kind}, {json_bytes} B, offered {offered[:8]}")

    _, _, artifact_text = get(f"/.well-known/hyperfly/{offered}")
    artifact = json.loads(artifact_text)
    codec = compile_ir(artifact["ir"], plan=artifact["plan"]["layout"], profile=artifact.get("profile") and {
        "version": 1,
        "shared": artifact["profile"],
    })
    assert codec.fingerprint == offered, "a client must verify what it was handed"
    registry.add(codec)
    print(f"2. fetched artifact, derived fingerprint matches: {codec.fingerprint[:8]}")

    status, headers, body = get("/v1/events", accept_header([codec.fingerprint]))
    kind, decoded = decode_response(headers.get("content-type"), body, registry)
    assert kind == "hyperfly", kind
    assert headers.get("vary") == "Hyperfly-Accept"
    print(f"3. binary -> {len(body)} B ({json_bytes / len(body):.1f}x smaller than the JSON)")

    assert decoded == value, "the two representations must carry the same value"
    print("4. binary value equals the JSON value the server sent first")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
