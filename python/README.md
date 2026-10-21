# hyperfly (Python)

Binary compression for typed APIs at the edge of entropy.

Your Pydantic models already fix every field name, type, and bound. Your traffic
already reveals what the values usually look like. Hyperfly compiles both into a
binary protocol for one exact route — and speaks JSON to anything that hasn't been
told.

The public API and wire format are stable for 1.x per [STABILITY.md](https://github.com/eliahilse/hyperfly/blob/main/STABILITY.md).

```bash
pip install "hyperfly[pydantic]"
```

## Two lines at the boundary

```python
from enum import Enum

from pydantic import BaseModel, Field

from hyperfly.pydantic import compile


class Status(str, Enum):
    ok = "ok"
    degraded = "degraded"


class Event(BaseModel):
    id: int = Field(ge=0)
    at_ms: int = Field(ge=0)
    status: Status
    message: str | None = None


class EventResponse(BaseModel):
    events: list[Event]
    cursor: str | None = None


codec = compile(EventResponse, validate=True)

response = EventResponse(events=[Event(id=1, at_ms=1_792_454_400_000, status=Status.ok)])
data = codec.encode(response)
value = codec.decode(data)  # an EventResponse; without validate=True, plain dicts
```

Anything the model already settles — field names, types, enum members, bounds,
optionality — never reaches the wire. Models it cannot encode fail loudly at compile
time, with the path:

```python
class Model(BaseModel):
    meta: dict[str, int]


compile(Model)  # UnsupportedSchemaError: $.meta: type dict[str, int] has no v0 encoding
```

## Without pydantic

The schema is plain JSON data, the IR defined in
[wire v0](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md), and
`compile_ir` takes it directly:

```python
from hyperfly import compile_ir, validate_ir

ir = {
    "kind": "struct",
    "fields": [
        {"name": "id", "type": {"kind": "int", "min": 0}},
        {"name": "name", "type": {"kind": "string"}},
        {"name": "status", "type": {"kind": "enum", "members": ["ok", "degraded"]}},
        {"name": "note", "type": {"kind": "string"}, "nullable": True},
        {"name": "tags", "type": {"kind": "array", "element": {"kind": "string"}}},
    ],
}

validate_ir(ir)  # raises HyperflyError code "ir" with the failing path
codec = compile_ir(ir)

value = {"id": 7, "name": "edge-1", "status": "ok", "note": None, "tags": ["eu", "edge"]}
assert codec.decode(codec.encode(value)) == value
```

Every field is required unless it is marked `"optional": true`; `"nullable": true`
only admits `None`. An int field or int literal also accepts an integral float such
as `1.0` and decodes it as an int. The integer domain is checked before the bounds, so
`11.0` against `"max": 10` fails with `range` and `1.5` with `type`.

## Pydantic types

`compile` and `to_ir` map annotations as follows:

| Annotation | IR |
| --- | --- |
| `bool` | `bool` |
| `int`, bounded by `ge`/`gt`/`le`/`lt` from `Field` or annotated-types | `int` with `min`/`max` |
| `float` | `float64` |
| `str`, `bytes` | `string`, `bytes` |
| `Enum` with string values, `Literal["a", "b", ...]` | `enum` |
| `Literal[x]` with a string, bool, `None` or safe int | `literal` |
| `list[T]` | `array` |
| `T \| None`, `Optional[T]` | `nullable` (a nullable field) |
| a `BaseModel` subclass | `struct` |

Integer bounds inside `Annotated` apply at any level: `list[Annotated[int, Field(ge=1)]]`
bounds the elements. String and list length constraints are not part of the IR, so a
codec without `validate=True` does not check them. A field with a default is still
required on the wire. A field
needs one wire name, so use `alias=`; differing serialization and validation names
or `AliasChoices`/`AliasPath` are refused. Everything else (`dict`, `tuple`, `set`,
`Any`, `datetime`, `Decimal`, other unions, `extra="allow"`, `RootModel`, recursive
models) raises `UnsupportedSchemaError` at compile time with the path.

Int bounds follow the model's own pydantic core schema. A field-level after, wrap or
plain validator (decorated or `Annotated`, at any container level) drops the bounds
beneath it. Values that bypass field validation (unvalidated defaults, model
validators, assignment, `model_construct`) keep the declared bounds, so encoding an
out-of-bounds one raises `range`.

`compile` returns a `ModelCodec`, a `Codec` subclass that registers in a
`CodecRegistry` like any other. Without `validate=True` it encodes models or plain
dicts (which must carry every field) and decodes to plain dicts. With it, values pass
through `model_validate` both ways, decoding returns models, and a `ValidationError`
is raised as `EncodeError` or `DecodeError` with code `validation`.

## Columns and profiles

```python
codec = compile(EventResponse, plan="columnar", validate=True)
```

The columnar plan lays an array of records out field by field. It turns timestamps
into deltas, exact-decimal numbers into integer mantissas, enums into indices and
booleans into bitmaps, and deflates text columns together. Row and columnar codecs
of the same model have different fingerprints, so a server can register both.

```python
from hyperfly import train
from hyperfly.pydantic import to_ir

samples = [r.model_dump(mode="json", by_alias=True) for r in recent_responses]
profile = train(to_ir(EventResponse), samples)
codec = compile(EventResponse, plan="columnar", profile=profile, validate=True)
```

A profile adds what only traffic can teach: the values that recur across
*different* responses, which a compressor never sees because it only ever holds one.
`train` returns `None` when the samples have nothing worth a profile. A value enters
a dictionary after `min_occurrences` (default 2, and 0 counts as 1) and a dictionary
holds at most `max_entries` (capped at 16383). A new profile produces a new
fingerprint, so register the previous codec next to the new one while clients move
over.

## Serving it

```python
from hyperfly import CodecRegistry
from hyperfly.http import negotiate, encode_for, serve_artifact

registry = CodecRegistry([codec, previous_codec])

decision = negotiate(
    request.headers.get("hyperfly-accept"),
    registry,
    http_accept=request.headers.get("accept"),
)
body, headers = encode_for(decision, payload, on_fallback=lambda reason, error: log.warning("%s: %s", reason, error))
```

`Accept: application/vnd.hyperfly;q=0` opts a client out of binary whatever it
advertises. A value the codec refuses under its limits is answered in JSON with the
same headers a fallback gets, and `on_fallback` hears about it. Every decision
carries `Vary: Hyperfly-Accept, Accept`. A JSON answer from `negotiate` offers the
first registered codec in `Hyperfly-Offer`; `offer=` names another, `offer=""` sends
none, and `enabled=False` never offers. An encoder-limit fallback always offers the
selected codec, whatever `offer` was.

Request bodies go through `decode_request`, which takes a `bytes` body or an
iterable of chunks and stops reading once the body passes `max_bytes` (1 MiB by
default):

```python
from hyperfly.http import RequestError, decode_request

try:
    kind, value = decode_request(
        request.headers.get("content-type"),
        request.headers.get("hyperfly-codec"),
        request.stream(),
        registry,
        content_length=request.headers.get("content-length"),
    )
except RequestError as error:
    return Response(status=error.status, headers=error.headers)
```

`error.status` is 415 for a content type that is neither hyperfly nor JSON, 413 past
`max_bytes` (a `Content-Length` above it is refused before reading), 400 for a
malformed envelope, a contradicting `Hyperfly-Codec` header or a body that fails to
decode, and 415 with `Hyperfly-Offer` for a fingerprint the registry does not hold.
`error.reason` names the rule for logs. `read_body` applies the same bound on its own
and returns `bytes`.

A client that holds nothing gets JSON plus a `Hyperfly-Offer` naming an artifact it
could fetch from `serve_artifact`; once it has it, the same route answers in binary.
There is no failure mode where the response is unreadable.

The JSON fallback writes pydantic models with `model_dump(mode="json", by_alias=True)`.
Bytes at declared `bytes` positions are written as standard padded base64; untyped
positions (`Any`, extras, computed fields, sets, dicts) follow pydantic's JSON mode,
including `ser_json_bytes`, and custom field serializers own their output. Plain
dicts, lists and tuples write every `bytes` value as base64, enums as their values
and non-finite floats as `null`, as `JSON.stringify` does. A value that cannot be
serialized raises `EncodeError` with code `json`.

Registering the outgoing codec alongside the incoming one is what makes retraining
safe: a new profile is a new fingerprint, so a deployment holding only one codec
turns every rollout into a cutover.

## Clients

```python
from hyperfly import CodecRegistry
from hyperfly.http import accept_header, decode_response

registry = CodecRegistry([codec])
headers = {"Hyperfly-Accept": accept_header(registry.fingerprints)}

reply = http.get(url, headers=headers)
kind, value = decode_response(reply.headers.get("content-type"), reply.content, registry)
```

`kind` is `"hyperfly"` for a binary body decoded by the matching codec (a model under
`validate=True`), `"json"` for a JSON body, or `"unknown-codec"` for a binary body
from a codec the registry does not hold, with the envelope's fingerprint as `value`.

JSON bodies, here and in `decode_request`, are converted and checked against the
registry's first codec: booleans, ints (integral numbers, within bounds), finite
float64 numbers, strings, enum members, literals, canonical padded base64 into
`bytes`, `null` only where nullable or a `null` literal (`Literal[None]`), fixed array
lengths and required fields. Unknown keys are dropped and results stay plain, even
for a validating codec. A mismatch raises `DecodeError` code `json` with the path
(400 `malformed-json` from `decode_request`). An empty registry returns the parsed
JSON unchanged.

## API

Names outside each module's `__all__`, and underscore modules, are private.

`hyperfly`
- `Codec`: compiled codec, generic in its value type; `encode`, `decode`, `encode_body`, `decode_body`, `fingerprint`, `artifact`, `plan`, `ir`, `profile`
- `compile_ir(ir, *, plan, limits, pack, profile)`: compile an IR schema; `Codec(ir, ...)` takes the same keyword options
- `CodecRegistry`: codecs by fingerprint; `add`, `remove`, `get`, `select`, `artifact`, `fingerprints`
- `train(ir, samples, *, min_occurrences, max_entries)`: a columnar profile, or `None`
- `validate_ir(ir)`, `validate_profile(ir, profile)`: raise code `ir` on invalid input
- `serialize_node(node)`, `serialize_artifact(ir, layout, profile)`: canonical JSON
- `fingerprint_of(artifact)`: the 16 fingerprint bytes of canonical artifact JSON
- `Limits`, `DEFAULT_LIMITS`: resource bounds and their defaults
- `PackHooks`: `deflate` and `inflate` hooks for packed text columns
- `HyperflyError`, `EncodeError`, `DecodeError`, `FingerprintMismatchError`, `UnsupportedSchemaError`: see Errors
- `INT_MIN`, `INT_MAX`: the safe integer domain, ±(2^53 - 1)
- `MAGIC`, `WIRE_VERSION`, `HEADER_SIZE`: the envelope's magic bytes, version byte and size

`hyperfly.pydantic`
- `compile(model, *, plan, validate, limits, pack, profile)`: a `ModelCodec`
- `ModelCodec`: a `Codec` for a pydantic model, with `model` and `validate`
- `to_ir(model)`: the model's IR

`hyperfly.http`
- `negotiate(accept, registry, *, http_accept, offer, enabled)`: a `Negotiation`
- `encode_for(decision, value, *, on_fallback)`: `(body, headers)`
- `serve_artifact(pathname, registry)`: an `ArtifactResponse`, or `None` off the well-known path
- `decode_request(content_type, codec_header, body, registry, *, max_bytes, content_length)`: a `DecodedRequest`
- `read_body(body, *, max_bytes, content_length)`: the body as `bytes`; `max_bytes` defaults to `DEFAULT_MAX_BODY_BYTES`, 1 MiB
- `accept_header(fingerprints)`, `parse_accept(header)`: write and read `Hyperfly-Accept`
- `decode_response(content_type, body, registry)`: `(kind, value)`
- `Negotiation`, `ArtifactResponse`, `DecodedRequest`: results of the functions above
- `RequestError`: a refused request, with `status`, `reason` and `headers`
- `FallbackReason`: why a response fell back to JSON, the `reason` of a `Negotiation`
- `HYPERFLY_MEDIA_TYPE`, `ACCEPT_HEADER`, `CODEC_HEADER`, `OFFER_HEADER`, `WELL_KNOWN_PREFIX`: media type, header names and artifact path

## Limits

`compile_ir(ir, limits=Limits(...))` bounds what one body can make a peer decode
([wire v0 §6](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md#6-limits)).
A body past a limit fails with code `limit` (`depth` for `max_depth`), and the
encoder refuses a value its own decoder would reject. Limits are not negotiated: a
route that legitimately ships denser payloads raises them on both peers.

| Field | Default | Bounds |
| --- | --- | --- |
| `max_depth` | 64 | struct, array and nullable nesting |
| `max_items` | 2^24 | items in one array |
| `max_byte_length` | 2^28 | bytes in one string or bytes value |
| `max_amplification` | 32 | items in one array: at most `max_amplification` × (remaining bytes + 1), or one item per remaining bit instead for a row-encoded array of non-zero-bit elements |
| `max_total_items` | 2^24 | items across every array in one body, and at most `max_amplification` × (body length + 1) |
| `max_total_bytes` | 2^26 | decoded bytes of every string and bytes value in one body, counting literals, enum members and dictionary, grammar and derived values |
| `max_byte_amplification` | 64 | those decoded bytes per body byte: at most `max_byte_amplification` × (body length + 1) |

Schemas and profiles need no stack sizing: one whose artifact nests up to the
512-level limit compiles, validates and trains without depending on Python's
recursion limit, and a deeper one fails with `ir`. Value nesting is bounded by
`max_depth` and reported as `depth`. Values are decoded recursively: on Python 3.10
or 3.11, under the default recursion limit of 1000, a value nested more than about
490 levels deep fails with `depth` even when `max_depth` allows it, and sooner when
the call starts deep in the stack; `sys.setrecursionlimit` raises it. `to_ir` walks
models recursively, so a model chain too deep for the stack raises
`UnsupportedSchemaError`.

## Errors

Every failure the package raises on purpose is a `HyperflyError` with a stable
`code`, under the same class names as the TypeScript package. A wrapped exception
stays reachable through `__cause__`.

| Class | Codes |
| --- | --- |
| `EncodeError` | `type`, `range`, `float`, `utf8`, `required`, `depth`, `limit`, `validation`, `json` |
| `DecodeError` | `header`, `truncated`, `trailing`, `varint`, `bitmap`, `marker`, `float`, `utf8`, `range`, `depth`, `limit`, `packed`, `unsupported`, `json`, `validation` |
| `FingerprintMismatchError` (a `DecodeError`) | `fingerprint` |
| `UnsupportedSchemaError` | `unsupported` |
| `HyperflyError` | `ir`, `options` |

`json` is a JSON body that `decode_response` or `decode_request` cannot parse (the
`json.JSONDecodeError`, `UnicodeDecodeError` or `RecursionError` is its `__cause__`)
or that does not match the codec's schema (the message names the path), or a JSON
fallback value `encode_for` cannot serialize. `validation` is a pydantic
`ValidationError` from a codec compiled with `validate=True`.

`options` is a malformed compile option, raised by `compile_ir`, `Codec` and the
pydantic `compile` before the schema is read: a `limits` that is neither `None` nor a
`Limits`, or has a field that is not an integer from 0 to 2^53 - 1; a `plan` other
than `"row"` or `"columnar"`; a `pack` other than `None`, `False` or a mapping whose
`deflate` and `inflate` are each a callable, `None` or absent; a `validate` other than
`True` or `False`; or an option that raises when read (the error is its `__cause__`).
Each option is read once. `train` raises it before reading the schema for samples
that are not a list or tuple, or a `min_occurrences` or `max_entries` that is not a
non-negative integer or integral float; `read_body` and `decode_request` before
reading the body for a `max_bytes` that is not an integer from 0 to 2^53 - 1.

`RequestError` is separate: it is not a `HyperflyError` and has no `code`. It is how
`read_body` and `decode_request` refuse a request, carrying `status` (400, 413 or
415), a stable `reason` and the response `headers`. Only a 400 wraps a cause: the
`DecodeError` for a body that fails to decode (so a JSON parse error is the
`__cause__` of that `DecodeError`, one hop further down), or the stream or buffer
error for an unreadable body. A 413 or 415 has no `__cause__`.

## Compatibility

The package supports Python 3.10 to 3.14, ships `py.typed` and type-checks under
`mypy --strict`. The public names in `__all__` and the
[wire format](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md) follow
semantic versioning.

## Differences from the TypeScript package

- No counterparts to `loadArtifact` and `fetchArtifact` yet; they are planned for a
  1.x release. A Python client compiles the codec from its own model or registers one.
- No Fetch API helpers (`respond`, `discovery`), since Python has no single request
  type; `negotiate`, `encode_for` and `serve_artifact` cover the same ground.
- Option names are snake_case: `max_depth` for `maxDepth`, `min_occurrences` for
  `minOccurrences`.
- `limits` takes a `Limits` instance rather than a partial mapping.

## Conformance

The authorities are the specifications, not this implementation. This package runs
the same golden vectors as the TypeScript and Rust implementations, and CI runs a
TypeScript server against this Python client over real HTTP on every push.

```bash
pip install ./python[test] && pytest python/tests -q
```

- [wire v0](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md)
- [columnar v5](https://github.com/eliahilse/hyperfly/blob/main/spec/plan-columnar-v5.md)
- [negotiation v1](https://github.com/eliahilse/hyperfly/blob/main/spec/negotiation-v1.md)

## License

[Apache License 2.0](https://github.com/eliahilse/hyperfly/blob/main/LICENSE)
