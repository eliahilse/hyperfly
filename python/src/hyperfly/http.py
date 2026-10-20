"""HTTP negotiation, JSON fallback and bounded request decoding.

HYPERFLY_MEDIA_TYPE names the binary representation. ACCEPT_HEADER, CODEC_HEADER
and OFFER_HEADER are the negotiation header names; WELL_KNOWN_PREFIX locates
artifacts. DEFAULT_MAX_BODY_BYTES is the default one-MiB request bound.
FallbackReason identifies disabled transport, refused or missing acceptance,
unmatched codecs, or encoder limits that trigger JSON fallback.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, NamedTuple, cast

from ._codec import HEADER_SIZE, MAGIC, WIRE_VERSION, Codec
from ._wire import INT_MAX, INT_MIN, DecodeError, EncodeError, HyperflyError
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
_MODEL_JSON_ATTRIBUTE = "__hyperfly_http_json__"


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
        hi = cast("re.Match[str]", _TRAILING_OWS.search(text, lo, hi)).start()
    return lo, hi


def _skip_ows(text: str, lo: int, hi: int) -> int:
    return cast("re.Match[str]", _LEADING_OWS.match(text, lo, hi)).end()


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
    offer=None advertises the first registered codec; offer="" suppresses the offer.
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
    chosen = offer if offer is not None else (registry.fingerprints[0] if registry.fingerprints else None)
    headers = {**vary, "Content-Type": "application/json"}
    if chosen:
        headers["Hyperfly-Offer"] = chosen
    return Negotiation("json", headers, reason=reason)


class _JSONModelMeta(type):
    def __instancecheck__(cls, instance: Any) -> bool:
        return hasattr(type(instance), "__pydantic_core_schema__")


class _JSONModel(metaclass=_JSONModelMeta):
    """Schema model marker without a prebuilt pydantic serializer."""


class _ModelJSON(NamedTuple):
    plan: dict[str, Any]
    serializer: Any


def _base64(value: bytes | bytearray) -> str:
    return base64.b64encode(value).decode("ascii")


def _build_model_json(cls: type[Any]) -> _ModelJSON:
    from pydantic_core import SchemaSerializer

    schema = cls.__pydantic_core_schema__
    definitions = {node["ref"]: node for node in schema.get("definitions", [])}
    copies: dict[int, dict[str, Any]] = {}
    plans: dict[int, dict[str, Any]] = {}
    references: dict[str, dict[str, Any]] = {}

    def visit(node: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        if id(node) in copies:
            return copies[id(node)], plans[id(node)]
        copied = dict(node)
        plan: dict[str, Any] = {"type": node["type"], "children": []}
        copies[id(node)] = copied
        plans[id(node)] = plan
        kind = node["type"]
        if "ref" in node:
            copied["ref"] = node["ref"] + ":hyperfly-http"
            references[copied["ref"]] = copied
        if kind == "bytes":
            # Only declared bytes get a safe JSON serializer; Any and other
            # containers retain their original serializer and configuration.
            if "serialization" not in node:
                copied["serialization"] = {"type": "function-plain", "function": _base64, "when_used": "json"}
        elif kind == "definition-ref":
            child, child_plan = visit(definitions[node["schema_ref"]])
            copied["schema_ref"] = child["ref"]
            plan["children"] = [child_plan]
        elif kind in ("definitions", "model", "nullable", "default", "function-before"):
            copied["schema"], child_plan = visit(node["schema"])
            plan["children"] = [child_plan]
            if kind == "model":
                copied["cls"] = _JSONModel
                plan["root"] = node.get("root_model", False)
        elif kind == "model-fields":
            copied["fields"] = dict(node["fields"])
            for name, item in node["fields"].items():
                if item.get("serialization_exclude"):
                    continue
                child, child_plan = visit(item["schema"])
                copied["fields"][name] = {**item, "schema": child}
                alias = item.get("serialization_alias")
                plan["children"].append((name, name if alias is None else alias, child_plan))
        elif kind == "list":
            copied["items_schema"], child_plan = visit(node["items_schema"])
            plan["children"] = [child_plan]
        elif kind in ("tuple", "tuple-positional", "tuple-variable"):
            items = node.get("items_schema", [])
            if isinstance(items, dict):
                copied["items_schema"], child_plan = visit(items)
                plan["children"] = [child_plan]
                plan["variadic"] = 0
            else:
                pairs = [visit(item) for item in items]
                copied["items_schema"] = [pair[0] for pair in pairs]
                plan["children"] = [pair[1] for pair in pairs]
                plan["variadic"] = node.get("variadic_item_index")
                if node.get("extras_schema") is not None:
                    copied["extras_schema"], child_plan = visit(node["extras_schema"])
                    plan["variadic"] = len(plan["children"])
                    plan["children"].append(child_plan)
        return copied, plan

    copied, plan = visit(schema)
    # Compute reachability to skip bytes-free fields, including recursive models.
    active = {id(item) for item in plans.values() if item["type"] == "bytes"}
    while True:
        previous = len(active)
        for item in plans.values():
            children = item["children"]
            if item["type"] == "model-fields":
                children = [entry[2] for entry in children]
            if any(id(child) in active for child in children):
                active.add(id(item))
        if len(active) == previous:
            break
    for item in plans.values():
        item["active"] = id(item) in active
    if not plan["active"]:
        return _ModelJSON(plan, None)
    # Keep the original definitions for paths outside the overlay contract.
    safe_schema = {
        "type": "definitions", "schema": copied,
        "definitions": list(definitions.values()) + list(references.values()),
    }
    if copied["type"] == "definitions":
        safe_schema["schema"] = copied["schema"]
    root_schema = schema
    while root_schema["type"] in ("definitions", "definition-ref"):
        root_schema = (
            root_schema["schema"] if root_schema["type"] == "definitions"
            else definitions[root_schema["schema_ref"]]
        )
    return _ModelJSON(plan, SchemaSerializer(safe_schema, root_schema.get("config")))


def _model_json(cls: type[Any]) -> _ModelJSON:
    cached = cls.__dict__.get(_MODEL_JSON_ATTRIBUTE)
    if cached is None:
        cached = _build_model_json(cls)
        # The class owns its complete entry: serializer references to the class
        # form a collectible cycle, without a global cache keeping it alive.
        setattr(cls, _MODEL_JSON_ATTRIBUTE, cached)
    return cast(_ModelJSON, cached)


def _overlay_model_bytes(plain: Any, source: Any, plan: dict[str, Any]) -> Any:
    root = [plain]
    pending: list[tuple[Any, Any, Any, dict[str, Any]]] = [(root, 0, source, plan)]
    while pending:
        parent, key, value, node = pending.pop()
        if not node["active"] or value is None:
            continue
        target = parent[key]
        kind = node["type"]
        children = node["children"]
        if kind == "bytes":
            if isinstance(value, (bytes, bytearray)):
                parent[key] = _base64(value)
        elif kind == "model-fields":
            if isinstance(target, dict):
                for name, alias, child in children:
                    if child["active"] and alias in target:
                        pending.append((target, alias, getattr(value, name), child))
        elif kind == "model":
            pending.append((parent, key, getattr(value, "root") if node["root"] else value, children[0]))
        elif kind in ("definitions", "definition-ref", "nullable", "default", "function-before"):
            pending.append((parent, key, value, children[0]))
        elif isinstance(value, (list, tuple)) and isinstance(target, list) and len(value) == len(target):
            for index, item in enumerate(value):
                if kind == "list":
                    child = children[0]
                else:
                    variadic = node["variadic"]
                    position = index
                    if variadic is not None and index >= variadic:
                        position = max(variadic, index - len(value) + len(children))
                    child = children[position]
                if child["active"]:
                    pending.append((target, index, item, child))
    return root[0]


def _json_value(value: Any) -> Any:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        if hasattr(type(value), "__pydantic_core_schema__"):
            from copy import copy

            cached = _model_json(type(value))
            if cached.serializer is not None:
                # An instance copy preserves model_dump overrides and exclusions
                # while using a private serializer, without mutating the model.
                shadow = copy(value)
                object.__setattr__(shadow, "__pydantic_serializer__", cached.serializer)
                plain = shadow.model_dump(mode="json", by_alias=True)
                return _overlay_model_bytes(plain, value, cached.plan)
        return model_dump(mode="json", by_alias=True)
    if isinstance(value, (bytes, bytearray)):
        return _base64(value)
    if isinstance(value, (dict, list, tuple)):
        return _json_container(value)
    from pydantic_core import to_jsonable_python

    return to_jsonable_python(value)


def _json_container(value: Any) -> Any:
    from pydantic_core import to_jsonable_python

    root: list[Any] = []
    active: set[int] = set()
    stack: list[tuple[Iterator[tuple[Any, Any]], Any, int | None]] = [(iter(((0, value),)), root, None)]
    while stack:
        children, parent, identity = stack[-1]
        try:
            key, item = next(children)
        except StopIteration:
            stack.pop()
            if identity is not None:
                active.remove(identity)
            continue
        if isinstance(item, (dict, list, tuple)) and not callable(getattr(item, "model_dump", None)):
            if id(item) in active:
                raise ValueError("Circular reference detected")
            active.add(id(item))
            converted: Any = {} if isinstance(item, dict) else []
            entries = iter(item.items()) if isinstance(item, dict) else iter(enumerate(item))
            stack.append((entries, converted, id(item)))
        else:
            converted = _json_value(item)
        if isinstance(parent, dict):
            # Keys retain pydantic's JSON spelling, including bytes and enums.
            json_key = next(iter(to_jsonable_python({key: None})))
            parent[json_key] = converted
        else:
            parent.append(converted)
    return root[0]


def _finite_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _finite_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_finite_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _json_body(value: Any) -> bytes:
    try:
        plain = _finite_json(_json_value(value))
        text = json.dumps(plain, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        # lone surrogates become \uXXXX escapes, as JSON.stringify writes them
        return text.encode("utf-8", "backslashreplace")
    except EncodeError:
        raise
    except Exception as error:
        if (
            isinstance(error, RecursionError)
            or (isinstance(error, ValueError) and str(error).startswith("Circular reference detected"))
        ):
            raise EncodeError("json", "JSON fallback value is circular or nested too deeply") from error
        raise EncodeError("json", f"JSON fallback serialization failed: {error}") from error


def encode_for(
    decision: Negotiation,
    value: Any,
    *,
    on_fallback: Callable[[FallbackReason, EncodeError], None] | None = None,
) -> tuple[bytes, dict[str, str]]:
    """Encode one value according to a negotiation decision.

    A value the codec refuses under its limits is answered in JSON, never an error
    (negotiation section 2); on_fallback hears about it so the route can be fixed.
    In JSON fallback, plain dicts, lists and tuples write bytes as standard padded
    base64. Pydantic models write base64 at declared bytes positions and follow
    JSON mode elsewhere, including Any and extras. Dict keys keep their JSON spelling.
    Serialization failures raise EncodeError with code ``json``.
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


@dataclass(slots=True)
class _JsonPath:
    parent: _JsonPath | None
    key: str | int | None


def _json_path(parent: _JsonPath | None, key: str | int | None) -> str:
    parts = []
    while True:
        if key is not None:
            parts.append(f"[{key}]" if isinstance(key, int) else f".{key}")
        if parent is None:
            break
        key, parent = parent.key, parent.parent
    return "$" + "".join(reversed(parts))


def _array_children(node: dict[str, Any], items: list[Any]) -> Iterator[tuple[dict[str, Any], Any, str | int | None]]:
    for index in range(len(items)):
        yield node, items, index


def _struct_children(node: dict[str, Any], items: dict[str, Any]) -> Iterator[tuple[dict[str, Any], Any, str | int | None]]:
    for field in node["fields"]:
        name = field["name"]
        if name in items and not (field.get("nullable") and items[name] is None):
            yield field["type"], items, name


def _convert_json(value: Any, registry: CodecRegistry) -> Any:
    fingerprints = registry.fingerprints
    codec = registry.get(fingerprints[0]) if fingerprints else None
    if codec is None:
        return value
    root = {None: value}
    stack: list[tuple[Iterator[tuple[dict[str, Any], Any, str | int | None]], _JsonPath | None]] = [
        (iter(((codec._ir, root, None),)), None),
    ]
    enums: dict[int, frozenset[str]] = {}
    while stack:
        children, path = stack[-1]
        try:
            node, parent, key = next(children)
        except StopIteration:
            stack.pop()
            continue
        item = parent[key]
        kind = node["kind"]
        while kind == "nullable" and item is not None:
            node = node["inner"]
            kind = node["kind"]
        if kind == "bool":
            if type(item) is not bool:
                raise DecodeError("json", f"{_json_path(path, key)}: expected boolean")
        elif kind == "int" or (kind == "literal" and type(node["value"]) in (int, float)):
            if (type(item) not in (int, float) or not INT_MIN <= item <= INT_MAX
                    or (type(item) is float and not item.is_integer())):
                raise DecodeError("json", f"{_json_path(path, key)}: expected integral number in the safe integer domain")
            integer = int(item)
            if kind == "literal":
                if integer != node["value"]:
                    raise DecodeError("json", f"{_json_path(path, key)}: literal mismatch")
            else:
                lo, hi = node.get("min"), node.get("max")
                if (lo is not None and integer < lo) or (hi is not None and integer > hi):
                    raise DecodeError("json", f"{_json_path(path, key)}: integer outside declared bounds")
            parent[key] = integer
        elif kind == "float64":
            if type(item) not in (int, float):
                raise DecodeError("json", f"{_json_path(path, key)}: expected number")
            try:
                number = float(item)
            except OverflowError as error:
                raise DecodeError("json", f"{_json_path(path, key)}: expected finite float64") from error
            if not math.isfinite(number):
                raise DecodeError("json", f"{_json_path(path, key)}: expected finite float64")
            parent[key] = number
        elif kind in ("string", "enum"):
            if type(item) is not str:
                raise DecodeError("json", f"{_json_path(path, key)}: expected string")
            if kind == "enum":
                members = enums.get(id(node))
                if members is None:
                    members = enums[id(node)] = frozenset(node["members"])
                if item not in members:
                    raise DecodeError("json", f"{_json_path(path, key)}: unknown enum member")
        elif kind == "literal":
            literal = node["value"]
            if type(item) is not type(literal) or item != literal:
                raise DecodeError("json", f"{_json_path(path, key)}: literal mismatch")
        elif kind == "bytes":
            if not isinstance(item, str):
                raise DecodeError("json", f"{_json_path(path, key)}: expected a base64 string")
            try:
                decoded = base64.b64decode(item, validate=True)
                if base64.b64encode(decoded).decode("ascii") != item:
                    raise ValueError("expected canonical padded base64")
            except (ValueError, binascii.Error) as error:
                raise DecodeError("json", f"{_json_path(path, key)}: expected canonical padded base64") from error
            parent[key] = decoded
        elif kind == "array":
            if not isinstance(item, list):
                raise DecodeError("json", f"{_json_path(path, key)}: expected array")
            if "length" in node and len(item) != node["length"]:
                raise DecodeError("json", f"{_json_path(path, key)}: array length does not match declared length")
            stack.append((_array_children(node["element"], item), _JsonPath(path, key)))
        elif kind == "struct":
            if not isinstance(item, dict):
                raise DecodeError("json", f"{_json_path(path, key)}: expected object")
            converted: dict[str, Any] = {}
            parent[key] = converted
            for field in reversed(node["fields"]):
                name = field["name"]
                if name not in item:
                    if not field.get("optional"):
                        raise DecodeError("json", f"{_json_path(path, key)}.{name}: missing required field")
                    continue
                converted[name] = item[name]
            stack.append((_struct_children(node, converted), _JsonPath(path, key)))
    return root[None]


def decode_response(content_type: str | None, body: bytes | str, registry: CodecRegistry) -> tuple[str, Any]:
    """Returns (kind, value) where kind is 'json', 'hyperfly', or 'unknown-codec'.

    A codec the client does not hold is not something it can recover from by guessing,
    so it is reported rather than attempted. Invalid UTF-8 or malformed JSON raises
    code ``json``; malformed binary raises the codec's decode errors.
    JSON is converted and checked against the first registered codec's schema:
    canonical padded base64 becomes bytes, integral numbers become ints, and
    unknown struct keys are dropped. Conversion failures raise ``json`` with the
    failing path. Results stay plain even for a validating model codec; an empty
    registry leaves parsed JSON unchanged. Conversion walks the schema iteratively.
    """
    if _essence(content_type) != HYPERFLY_MEDIA_TYPE:
        value = _loads(bytes(body) if isinstance(body, (bytearray, memoryview)) else body)
        return "json", _convert_json(value, registry)
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
    bound is pulled. Content-Length rejects before reading only when its ASCII
    digits, trimmed of SP/HTAB, exceed the bound; leading zeros are harmless and
    every other spelling is ignored. A chunk source that fails is a 400. Invalid
    max_bytes raises code ``options``.
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
    JSON is converted and checked iteratively against the first registered codec's
    schema: canonical padded base64 becomes bytes, integral numbers become ints,
    and unknown struct keys are dropped. Conversion failures raise 400 with reason
    malformed-json and a path-bearing DecodeError cause. Results stay plain even
    for a validating model codec; an empty registry leaves parsed JSON unchanged.
    A valid Content-Length above max_bytes rejects before reading; other values
    are ignored after trimming SP/HTAB and checking for ASCII digits.
    """
    max_bytes = _checked_max_bytes(max_bytes)
    essence = _essence(content_type)
    hyperfly = essence == HYPERFLY_MEDIA_TYPE
    if not hyperfly and not _is_json(essence):
        raise RequestError(415, "unsupported-media-type")
    data = read_body(body, max_bytes=max_bytes, content_length=content_length)
    if not hyperfly:
        try:
            return DecodedRequest("json", _convert_json(_loads(data), registry))
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
