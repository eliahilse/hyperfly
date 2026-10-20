# hyperfly (Python)

Binary compression for typed APIs at the edge of entropy.

Your Pydantic models already fix every field name, type, and bound. Your traffic
already reveals what the values usually look like. Hyperfly compiles both into a
binary protocol for one exact route — and speaks JSON to anything that hasn't been
told.

> **Pre-release.** The wire format is specified and three implementations agree on
> it byte-for-byte, but nothing is stable yet.

```bash
pip install hyperfly[pydantic]
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

data = codec.encode(response)
value = codec.decode(data)  # an EventResponse; without validate=True, plain dicts
```

Anything the model already settles — field names, types, enum members, bounds,
optionality — never reaches the wire. Models it cannot encode fail loudly at compile
time, with the path:

```python
compile(Model)  # UnsupportedSchemaError: $.meta: dict[str, int] has no v0 encoding
```

## Columns

```python
codec = compile(EventResponse, plan="columnar", validate=True)
```

The columnar plan lays an array of records out field by field. It turns timestamps
into deltas, exact-decimal numbers into integer mantissas, enums into indices and
booleans into bitmaps, and deflates text columns together. Row and columnar codecs
of the same model have different fingerprints, so a server can register both.

## Serving it

```python
from hyperfly import CodecRegistry
from hyperfly.http import negotiate, encode_for, serve_artifact

registry = CodecRegistry([codec, previous_codec])

decision = negotiate(request.headers.get("hyperfly-accept"), registry)
body, headers = encode_for(decision, payload)
```

A client that holds nothing gets JSON plus a `Hyperfly-Offer` naming an artifact it
could fetch from `serve_artifact`; once it has it, the same route answers in binary.
There is no failure mode where the response is unreadable.

Registering the outgoing codec alongside the incoming one is what makes retraining
safe: a new profile is a new fingerprint, so a deployment holding only one codec
turns every rollout into a cutover.

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
