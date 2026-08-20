# hyperfly

Binary compression for typed APIs at the edge of entropy.

Your schema already fixes every field name, type, and bound. Your traffic already
reveals what the values usually look like. Hyperfly compiles both into a binary
protocol for one exact route — and speaks JSON to anything that hasn't been told.

> **Pre-release.** The wire format is specified and three implementations agree on
> it byte-for-byte, but nothing is stable yet. Expect breaking changes before 1.0.

```bash
npm install hyperfly zod
```

## Two lines at the boundary

```ts
import { compile } from "hyperfly/zod";

const codec = compile(EventResponse);

const bytes = codec.encode(response);
const value = codec.decode(bytes);
```

`compile` walks your Zod schema, derives a canonical description of it, and
fingerprints that description. Anything the schema already settles — field names,
types, enum members, bounds, optionality — never reaches the wire.

Schemas it cannot encode fail loudly at compile time, with the path:

```ts
compile(z.object({ meta: z.record(z.string(), z.unknown()) }));
// UnsupportedSchemaError: $.meta: record has no v0 encoding
```

## Columns and profiles

Arrays of records encode far better column-wise, which is a different plan for the
same schema:

```ts
const codec = compile(EventResponse, { plan: "columnar" });
```

Timestamps become deltas, exact-decimal numbers travel as integer mantissas, enums
become indices, booleans pack into bitmaps, and text columns deflate together.

A **profile** adds what only traffic can teach: the values that recur across
*different* responses, which a compressor never sees because it only ever holds
one.

```ts
import { train } from "hyperfly";

const profile = train(toIR(EventResponse), lastWeeksResponses);
const codec = compile(EventResponse, { plan: "columnar", profile });
```

The dictionary is an out-of-band artifact — it ships once, not per request. On an
audit-log route in the repo's benchmark it costs 12 KB and pays for itself after
ten requests.

## Serving it

A peer decodes only an artifact it holds, so that has to be established before any
bytes are sent. `hyperfly/http` implements the negotiation:

```ts
import { CodecRegistry } from "hyperfly";
import { discovery, respond } from "hyperfly/http";

const registry = new CodecRegistry([codec, previousCodec]);

export default {
  fetch(request: Request) {
    return (
      discovery(request, registry) ??      // .well-known artifact serving
      respond(request, payload, registry)  // binary if the client can read it, else JSON
    );
  },
};
```

A client that holds nothing gets JSON plus a `Hyperfly-Offer` naming an artifact it
could fetch; once it has it, the same route answers in binary. There is no failure
mode where the response is unreadable.

Registering the outgoing codec alongside the incoming one is what makes retraining
safe: a new profile is a new fingerprint, so a deployment holding only one codec
turns every rollout into a cutover.

Works anywhere `Request`/`Response` do — Hono, Cloudflare Workers, Bun.serve, Deno,
Next route handlers. For other stacks, `negotiate()` and `encodeFor()` take headers
and return a decision.

## What it costs on the wire

Bytes per message, averaged over 500-message corpora, from `apps/bench` in the repo:

| route | JSON | JSON+Brotli | Protobuf | Hyperfly | + Brotli | Profiled |
|---|---|---|---|---|---|---|
| audit events | 12,687 | 2,512 | 7,190 | 2,109 | 2,054 | **823** |
| device telemetry | 7,994 | 1,422 | 2,007 | 896 | 818 | **638** |
| social feed | 6,863 | 2,294 | 4,396 | 1,908 | 1,902 | **1,535** |
| single order | 782 | 408 | 388 | 271 | 273 | **188** |
| OHLCV candles | 3,225 | 842 | 2,034 | 496 | **372** | 372 |

Read the spread, not the best row. Profiles are worth 57% on audit logs, where the
same user agents recur on every request, and nothing at all on candles, whose only
string sits outside the array. The corpora are synthetic — shaped like real routes,
but not captured from one — and no production traffic has been measured yet.

## Guarantees

- **Exact-schema compatibility.** Any change to the schema or plan is a new
  fingerprint. A mismatch fails before the body is parsed; it never misreads.
- **Canonical output.** Decode then re-encode returns identical bytes, so a
  response is reproducible.
- **Bounded decoding.** Nesting, item counts and byte lengths are limited; a
  declared count must be payable by the bytes still on the wire.
- **One wire format.** [TypeScript](https://github.com/eliahilse/hyperfly/tree/main/packages/hyperfly),
  [Python](https://github.com/eliahilse/hyperfly/tree/main/python) and
  [Rust](https://github.com/eliahilse/hyperfly/tree/main/rust) are verified against
  the same golden vectors, and CI runs a TypeScript server against a Python client
  over real HTTP on every push.

## Reference

| | |
|---|---|
| `compile(schema, options?)` | Zod schema → codec. `plan`, `profile`, `limits`, `pack`, `validate`. |
| `compileIR(ir, options?)` | Same, from a canonical IR directly. |
| `train(ir, samples, options?)` | Sampled responses → profile. Non-normative. |
| `CodecRegistry` | Codecs by fingerprint; what makes rotation safe. |
| `negotiate` · `respond` · `discovery` · `readBody` | HTTP integration. |
| `codec.fingerprint` · `codec.artifact` | What identifies and describes a codec. |

The authorities are the specifications, not this implementation:
[wire v0](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md),
[columnar v3](https://github.com/eliahilse/hyperfly/blob/main/spec/plan-columnar-v3.md),
[negotiation v1](https://github.com/eliahilse/hyperfly/blob/main/spec/negotiation-v1.md).
A future implementation ports against the
[golden vectors](https://github.com/eliahilse/hyperfly/tree/main/spec/vectors), not
against this code.

## License

[Apache License 2.0](./LICENSE)
