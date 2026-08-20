from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from ._codec import Codec
from .registry import CodecRegistry

HYPERFLY_MEDIA_TYPE = "application/vnd.hyperfly"
ACCEPT_HEADER = "hyperfly-accept"
CODEC_HEADER = "hyperfly-codec"
OFFER_HEADER = "hyperfly-offer"
WELL_KNOWN_PREFIX = "/.well-known/hyperfly/"

_MAX_ACCEPTED = 32
_FINGERPRINT = re.compile(r"^[0-9a-f]{32}$")


def parse_accept(header: str | None) -> list[str]:
    """Fingerprints the client can decode, in its order of preference.

    Client-controlled input, so parsing is bounded and malformed entries are dropped
    rather than failing the request (negotiation section 6).
    """
    if not header:
        return []
    out: list[str] = []
    for part in header.split(","):
        if len(out) >= _MAX_ACCEPTED:
            break
        value = part.strip().lower()
        if _FINGERPRINT.match(value) and value not in out:
            out.append(value)
    return out


@dataclass(frozen=True)
class Negotiation:
    kind: str
    headers: dict[str, str]
    codec: Codec | None = None


def negotiate(
    accept: str | None,
    registry: CodecRegistry,
    *,
    offer: str | None = None,
    enabled: bool = True,
) -> Negotiation:
    """Decide how to answer one request.

    Vary is always set: the same URL yields either representation, and a shared cache
    would otherwise hand one peer's binary to a peer that cannot read it.
    """
    vary = {"Vary": "Hyperfly-Accept"}

    if not enabled:
        return Negotiation("json", {**vary, "Content-Type": "application/json"})

    codec = registry.select(parse_accept(accept))
    if codec is not None:
        return Negotiation(
            "hyperfly",
            {**vary, "Content-Type": HYPERFLY_MEDIA_TYPE, "Hyperfly-Codec": codec.fingerprint},
            codec,
        )

    chosen = offer or (registry.fingerprints[0] if registry.fingerprints else None)
    headers = {**vary, "Content-Type": "application/json"}
    if chosen:
        headers["Hyperfly-Offer"] = chosen
    return Negotiation("json", headers)


def encode_for(decision: Negotiation, value: Any) -> tuple[bytes, dict[str, str]]:
    if decision.kind == "hyperfly" and decision.codec is not None:
        return decision.codec.encode(value), decision.headers
    return json.dumps(value, separators=(",", ":")).encode("utf-8"), decision.headers


@dataclass(frozen=True)
class ArtifactResponse:
    status: int
    body: str
    headers: dict[str, str] = field(default_factory=dict)


def serve_artifact(pathname: str, registry: CodecRegistry) -> ArtifactResponse | None:
    """Serve .well-known artifact discovery, or None when the path is not ours.

    Artifacts are content-addressed, so a hit is immutable and cacheable forever; a
    miss is a 404 and not an error, because the client simply stays on JSON.
    """
    if not pathname.startswith(WELL_KNOWN_PREFIX):
        return None
    fingerprint = pathname[len(WELL_KNOWN_PREFIX) :].lower()
    if not _FINGERPRINT.match(fingerprint):
        return ArtifactResponse(404, "", {"Cache-Control": "no-store"})
    artifact = registry.artifact(fingerprint)
    if artifact is None:
        return ArtifactResponse(404, "", {"Cache-Control": "no-store"})
    return ArtifactResponse(
        200,
        artifact,
        {"Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable"},
    )


def accept_header(fingerprints: list[str]) -> str:
    return ", ".join(fingerprints)


def decode_response(content_type: str | None, body: bytes | str, registry: CodecRegistry) -> tuple[str, Any]:
    """Returns (kind, value) where kind is 'json', 'hyperfly', or 'unknown-codec'.

    A codec the client does not hold is not something it can recover from by guessing,
    so it is reported rather than attempted.
    """
    if not (content_type or "").lower().startswith(HYPERFLY_MEDIA_TYPE):
        text = body.decode("utf-8") if isinstance(body, bytes) else body
        return "json", json.loads(text)
    data = body.encode("utf-8") if isinstance(body, str) else body
    fingerprint = data[3:19].hex()
    codec = registry.get(fingerprint)
    if codec is None:
        return "unknown-codec", fingerprint
    return "hyperfly", codec.decode(data)
