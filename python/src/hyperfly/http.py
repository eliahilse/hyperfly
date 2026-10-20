"""HTTP negotiation, JSON fallback and bounded request decoding.

HYPERFLY_MEDIA_TYPE names the binary representation. ACCEPT_HEADER, CODEC_HEADER
and OFFER_HEADER are the negotiation header names; WELL_KNOWN_PREFIX locates
artifacts. DEFAULT_MAX_BODY_BYTES is the default one-MiB request bound.
FallbackReason identifies disabled transport, refused or missing acceptance,
unmatched codecs, or encoder limits that trigger JSON fallback.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Iterable, Literal, NamedTuple, cast

from ._codec import HEADER_SIZE, MAGIC, WIRE_VERSION, Codec
from ._wire import INT_MAX, DecodeError, EncodeError, HyperflyError
from .registry import CodecRegistry

HYPERFLY_MEDIA_TYPE = "application/vnd.hyperfly"
ACCEPT_HEADER = "hyperfly-accept"
CODEC_HEADER = "hyperfly-codec"
OFFER_HEADER = "hyperfly-offer"
WELL_KNOWN_PREFIX = "/.well-known/hyperfly/"
DEFAULT_MAX_BODY_BYTES = 1 << 20

FallbackReason = Literal["disabled", "accept-refused", "no-hyperfly-accept", "no-match", "encoder-limit"]

_MAX_ACCEPTED = 32
_FINGERPRINT = re.compile(r"^[0-9a-f]{32}$")
_VARY = "Hyperfly-Accept, Accept"
_OWS = " \t"
_LEADING_OWS = re.compile(r"[ \t]*")
_TRAILING_OWS = re.compile(r"(?<![ \t])[ \t]+\Z")
# a quote and the backslashes before it; an even run means the quote is not escaped
_CLOSING_QUOTE = re.compile(r'(?<!\\)\\*"')
_RANKS = {HYPERFLY_MEDIA_TYPE: 3, "application/*": 2, "*/*": 1}
_QVALUE = re.compile(r"0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?")
_JSON_SUFFIX = re.compile(r"[!#$%&'*+.^_`|~0-9a-z-]+/[!#$%&'*+.^_`|~0-9a-z-]+\+json")


def parse_accept(header: str | None) -> list[str]:
    """Fingerprints the client can decode, in its order of preference.

    Client-controlled input, so parsing is bounded and malformed entries are dropped
    rather than failing the request (negotiation section 6).
    """
    if not header:
        return []
    out: list[str] = []
    start = 0
    for _ in range(_MAX_ACCEPTED):
        end = header.find(",", start)
        stop = len(header) if end == -1 else end
        lo, hi = start, stop
        while lo < hi and header[lo] in " \t":
            lo += 1
        while hi > lo and header[hi - 1] in " \t":
            hi -= 1
        if hi - lo == 32:
            value = header[lo:hi]
            if _FINGERPRINT.fullmatch(value) and value not in out:
                out.append(value)
        if end == -1:
            break
        start = end + 1
    return out


@dataclass(frozen=True)
class Negotiation:
    """A response representation, headers, selected codec, and optional fallback reason."""

    kind: str
    headers: dict[str, str]
    codec: Codec[Any] | None = None
    reason: FallbackReason | None = None


def _trim(text: str, lo: int, hi: int) -> tuple[int, int]:
    lo = _skip_ows(text, lo, hi)
    if lo < hi and text[hi - 1] in _OWS:
        hi = cast(re.Match[str], _TRAILING_OWS.search(text, lo, hi)).start()
    return lo, hi


def _skip_ows(text: str, lo: int, hi: int) -> int:
    return cast(re.Match[str], _LEADING_OWS.match(text, lo, hi)).end()


def _media_rank(text: str, lo: int, hi: int) -> int:
    # compares without slicing the range, which may be as long as the header
    lo = _skip_ows(text, lo, hi)
    for media, rank in _RANKS.items():
        end = lo + len(media)
        if end <= hi and _lower(text[lo:end]) == media and _skip_ows(text, end, hi) == hi:
            return rank
    return 0


def _lower(text: str) -> str:
    # tokens are ASCII; lower() would fold e.g. the Kelvin sign into "k"
    return text.lower() if text.isascii() else text


def _range_end(header: str, pos: int) -> int:
    """End of the media range starting at pos: the next comma outside a quoted string."""
    size = len(header)
    comma = header.find(",", pos)
    if comma == -1:
        comma = size
    while True:
        slash = header.find("\\", pos, comma)
        stop = comma if slash == -1 else slash
        if header.count('"', pos, stop) % 2 == 0:
            if slash == -1:
                return comma
            # a backslash outside a quoted string is literal
            pos = header.find('"', slash, comma)
            if pos == -1:
                return comma
            continue
        pos = header.rfind('"', pos, stop) + 1
        while True:
            match = _CLOSING_QUOTE.search(header, pos)
            if match is None:
                return size
            pos = match.end()
            if (pos - match.start()) % 2:
                break
        if pos > comma:
            comma = header.find(",", pos)
            if comma == -1:
                comma = size


def _refuses_binary(accept: str | None) -> bool:
    """Whether an HTTP Accept header opts out of hyperfly (negotiation section 1).

    The most specific valid range among application/vnd.hyperfly, application/* and
    */* decides, the first listed winning a tie; only the first 32 ranges count.
    """
    if not accept:
        return False
    size = len(accept)
    start = 0
    specificity = 0
    refused = False
    for _ in range(_MAX_ACCEPTED):
        if start > size:
            break
        end = _range_end(accept, start)
        semicolon = accept.find(";", start, end)
        rank = _media_rank(accept, start, end if semicolon == -1 else semicolon)
        start = end + 1
        if rank <= specificity:
            continue
        zero = False
        if semicolon != -1:
            equals = accept.find("=", semicolon + 1, end)
            if equals == -1:
                continue
            lo = _skip_ows(accept, semicolon + 1, equals)
            if lo == equals or accept[lo] not in "qQ" or _skip_ows(accept, lo + 1, equals) != equals:
                continue
            lo = _skip_ows(accept, equals + 1, end)
            match = _QVALUE.match(accept, lo, end)
            if match is None or _skip_ows(accept, match.end(), end) != end:
                continue
            zero = float(match.group()) == 0
        specificity = rank
        refused = zero
    return refused


def negotiate(
    accept: str | None,
    registry: CodecRegistry,
    *,
    http_accept: str | None = None,
    offer: str | None = None,
    enabled: bool = True,
) -> Negotiation:
    """Decide how to answer one request from its Hyperfly-Accept and Accept headers.

    Vary is always set: the same URL yields either representation, and a shared cache
    would otherwise hand one peer's binary to a peer that cannot read it.
    """
    vary = {"Vary": _VARY}

    if not enabled:
        return Negotiation("json", {**vary, "Content-Type": "application/json"}, reason="disabled")

    refused = _refuses_binary(http_accept)
    codec = None if refused else registry.select(parse_accept(accept))
    if codec is not None:
        return Negotiation(
            "hyperfly",
            {**vary, "Content-Type": HYPERFLY_MEDIA_TYPE, "Hyperfly-Codec": codec.fingerprint},
            codec,
        )

    reason: FallbackReason = "accept-refused" if refused else "no-match" if accept else "no-hyperfly-accept"
    chosen = offer or (registry.fingerprints[0] if registry.fingerprints else None)
    headers = {**vary, "Content-Type": "application/json"}
    if chosen:
        headers["Hyperfly-Offer"] = chosen
    return Negotiation("json", headers, reason=reason)


def _json_key(key: Any) -> Any:
    if isinstance(key, Enum):
        key = key.value
    if isinstance(key, float) and not math.isfinite(key):
        return "NaN" if key != key else ("Infinity" if key > 0 else "-Infinity")
    return key


def _json_value(value: Any) -> Any:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        value = model_dump(mode="json", by_alias=True)
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {_json_key(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _json_body(value: Any) -> bytes:
    try:
        plain = _json_value(value)
    except RecursionError:
        raise ValueError("JSON fallback value is circular or nested too deeply") from None
    text = json.dumps(plain, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    # lone surrogates become \uXXXX escapes, as JSON.stringify writes them
    return text.encode("utf-8", "backslashreplace")


def encode_for(
    decision: Negotiation,
    value: Any,
    *,
    on_fallback: Callable[[FallbackReason, EncodeError], None] | None = None,
) -> tuple[bytes, dict[str, str]]:
    """Encode one value according to a negotiation decision.

    A value the codec refuses under its limits is answered in JSON, never an error
    (negotiation section 2); on_fallback hears about it so the route can be fixed.
    """
    if decision.kind == "hyperfly" and decision.codec is not None:
        try:
            return decision.codec.encode(value), decision.headers
        except EncodeError as error:
            if error.code not in ("limit", "depth"):
                raise
            if on_fallback is not None:
                on_fallback("encoder-limit", error)
            headers = {"Vary": _VARY, "Content-Type": "application/json", "Hyperfly-Offer": decision.codec.fingerprint}
            return _json_body(value), headers
    return _json_body(value), decision.headers


@dataclass(frozen=True)
class ArtifactResponse:
    """Artifact discovery HTTP status, canonical JSON body, and cache headers."""

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
    """Join valid lowercase fingerprints into a Hyperfly-Accept header value."""
    return ", ".join(fingerprint for fingerprint in fingerprints if _FINGERPRINT.fullmatch(fingerprint))


def _essence(content_type: str | None) -> str:
    if content_type is None:
        return "application/json"
    semicolon = content_type.find(";")
    lo, hi = _trim(content_type, 0, len(content_type) if semicolon == -1 else semicolon)
    return _lower(content_type[lo:hi])


def _envelope_fingerprint(data: bytes) -> str:
    if len(data) < HEADER_SIZE:
        raise DecodeError("header", "shorter than envelope header")
    if data[:2] != MAGIC:
        raise DecodeError("header", "bad magic")
    if data[2] != WIRE_VERSION:
        raise DecodeError("header", f"unsupported wire major {data[2]}")
    return data[3:HEADER_SIZE].hex()


def _json_int(token: str) -> int | float:
    try:
        return int(token)
    except ValueError:
        # past the interpreter's digit limit; JSON.parse yields a double, here infinite
        return float(token)


def _utf8(text: str) -> bytes:
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        # as TextEncoder does: pair surrogates, replace lone ones with U+FFFD
        return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _loads(body: bytes | str) -> Any:
    def reject_constant(value: str) -> Any:
        raise json.JSONDecodeError(f"invalid JSON constant {value}", text, 0)

    try:
        text = body.decode("utf-8-sig") if isinstance(body, bytes) else body
        return json.loads(text, parse_int=_json_int, parse_constant=reject_constant)
    except (ValueError, RecursionError) as error:
        raise DecodeError("json", f"malformed JSON body: {error}") from error


def decode_response(content_type: str | None, body: bytes | str, registry: CodecRegistry) -> tuple[str, Any]:
    """Returns (kind, value) where kind is 'json', 'hyperfly', or 'unknown-codec'.

    A codec the client does not hold is not something it can recover from by guessing,
    so it is reported rather than attempted. Malformed JSON raises code ``json``;
    malformed binary raises the codec's decode errors.
    """
    if _essence(content_type) != HYPERFLY_MEDIA_TYPE:
        return "json", _loads(bytes(body) if isinstance(body, (bytearray, memoryview)) else body)
    data = _utf8(body) if isinstance(body, str) else bytes(body)
    fingerprint = _envelope_fingerprint(data)
    codec = registry.get(fingerprint)
    if codec is None:
        return "unknown-codec", fingerprint
    return "hyperfly", codec.decode(data)


class RequestError(Exception):
    """A request body the server must refuse (negotiation section 4).

    status is 400, 413 or 415; reason is stable for logs and metrics; headers carry
    Hyperfly-Offer when the fingerprint is unknown.
    """

    def __init__(self, status: int, reason: str, headers: dict[str, str] | None = None) -> None:
        """Store the HTTP status, stable reason, and optional response headers."""
        super().__init__(f"{status} {reason}")
        self.status = status
        self.reason = reason
        self.headers = headers or {}


class DecodedRequest(NamedTuple):
    """A decoded request's representation kind and plain or codec-specific value."""

    kind: str
    value: Any


def _checked_max_bytes(max_bytes: Any) -> int:
    kind = type(max_bytes)
    number = int.__index__(max_bytes) if issubclass(kind, int) and kind is not bool else -1
    if not 0 <= number <= INT_MAX:
        raise HyperflyError("options", "max_bytes: must be a non-negative safe integer")
    return number


def _exceeds(content_length: str | int, max_bytes: int) -> bool:
    if isinstance(content_length, int):
        return content_length > max_bytes
    lo, hi = _trim(content_length, 0, len(content_length))
    digits = content_length[lo:hi]
    if not digits or not digits.isascii() or not digits.isdigit():
        return False
    digits = digits.lstrip("0")
    limit = str(max_bytes)
    return len(digits) > len(limit) or (len(digits) == len(limit) and digits > limit)


def read_body(
    body: bytes | bytearray | memoryview | Iterable[bytes],
    *,
    max_bytes: int = DEFAULT_MAX_BODY_BYTES,
    content_length: str | int | None = None,
) -> bytes:
    """Read a request body, refusing it with 413 as soon as it passes max_bytes.

    Bytes are counted as chunks arrive, so no chunk past the one that crosses the
    bound is pulled; Content-Length only rejects early. A chunk source that fails is
    a 400. Invalid max_bytes raises code ``options``.
    """
    max_bytes = _checked_max_bytes(max_bytes)
    if content_length is not None and _exceeds(content_length, max_bytes):
        raise RequestError(413, "too-large")
    if isinstance(body, (bytes, bytearray, memoryview)):
        try:
            with memoryview(body) as view:
                if view.nbytes > max_bytes:
                    raise RequestError(413, "too-large")
                return body if type(body) is bytes else view.tobytes()
        except (MemoryError, RequestError):
            raise
        except Exception as error:
            raise RequestError(400, "unreadable") from error
    chunks: list[bytes] = []
    length = 0
    try:
        iterator = iter(body)
    except MemoryError:
        raise
    except Exception as error:
        raise RequestError(400, "unreadable") from error
    while True:
        try:
            chunk = next(iterator)
        except StopIteration:
            break
        except MemoryError:
            raise
        except Exception as error:
            raise RequestError(400, "unreadable") from error
        try:
            # copied and released before the next pull: a producer may reuse its buffer
            with memoryview(chunk) as view:
                size = view.nbytes
                data = b"" if length + size > max_bytes else chunk if type(chunk) is bytes else view.tobytes()
        except MemoryError:
            raise
        except Exception as error:
            raise RequestError(400, "unreadable") from error
        del chunk
        length += size
        if length > max_bytes:
            close = getattr(iterator, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            raise RequestError(413, "too-large")
        if size:
            chunks.append(data)
    return b"".join(chunks)


def _is_json(essence: str) -> bool:
    return essence == "application/json" or _JSON_SUFFIX.fullmatch(essence) is not None


def _codec_header_matches(header: str, fingerprint: str) -> bool:
    lo, hi = _trim(header, 0, len(header))
    return hi - lo == len(fingerprint) and header[lo:hi] == fingerprint


def decode_request(
    content_type: str | None,
    codec_header: str | None,
    body: bytes | bytearray | memoryview | Iterable[bytes],
    registry: CodecRegistry,
    *,
    max_bytes: int = DEFAULT_MAX_BODY_BYTES,
    content_length: str | int | None = None,
) -> DecodedRequest:
    """Read and decode a hyperfly or JSON request body (negotiation section 4).

    Raises RequestError with the status of the first rule that applies: 415 for a
    content type that is neither, 413 past max_bytes, 400 for a malformed envelope or
    a Hyperfly-Codec header that contradicts it, 415 with Hyperfly-Offer for an
    unknown fingerprint, 400 for a body that fails to decode. Invalid max_bytes
    raises HyperflyError with code ``options``.
    """
    max_bytes = _checked_max_bytes(max_bytes)
    essence = _essence(content_type)
    hyperfly = essence == HYPERFLY_MEDIA_TYPE
    if not hyperfly and not _is_json(essence):
        raise RequestError(415, "unsupported-media-type")
    data = read_body(body, max_bytes=max_bytes, content_length=content_length)
    if not hyperfly:
        try:
            return DecodedRequest("json", _loads(data))
        except DecodeError as error:
            raise RequestError(400, "malformed-json") from error
    try:
        fingerprint = _envelope_fingerprint(data)
    except DecodeError as error:
        raise RequestError(400, "malformed-envelope") from error
    if codec_header is not None and not _codec_header_matches(codec_header, fingerprint):
        raise RequestError(400, "codec-mismatch")
    codec = registry.get(fingerprint)
    if codec is None:
        offer = registry.fingerprints[:1]
        raise RequestError(415, "unknown-codec", {"Hyperfly-Offer": offer[0]} if offer else None)
    try:
        return DecodedRequest("hyperfly", codec.decode(data))
    except HyperflyError as error:
        raise RequestError(400, "undecodable") from error


__all__ = [
    "HYPERFLY_MEDIA_TYPE", "ACCEPT_HEADER", "CODEC_HEADER", "OFFER_HEADER",
    "WELL_KNOWN_PREFIX", "DEFAULT_MAX_BODY_BYTES", "FallbackReason",
    "Negotiation", "ArtifactResponse", "DecodedRequest", "RequestError",
    "parse_accept", "negotiate", "encode_for", "serve_artifact", "accept_header",
    "decode_response", "read_body", "decode_request",
]
