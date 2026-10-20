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

Zod 4 is needed only for `hyperfly/zod`; the codec and HTTP entry points do not require it.

## Two lines at the boundary

```ts
import { z } from "zod";
import { compile } from "hyperfly/zod";

const EventResponse = z.object({
  events: z.array(z.object({
    id: z.string(), timestamp: z.int().nonnegative(), kind: z.enum(["created", "updated"]),
  })),
});
const response = { events: [{ id: "evt_001", timestamp: 1_700_000_000, kind: "created" as const }] };
const codec = compile(EventResponse);

const bytes = codec.encode(response);
const value = codec.decode(bytes);
```

`compile` walks your Zod schema, derives a canonical description and fingerprints it. Field names, types, enum
members, bounds and optionality are settled by the schema and never reach the wire.

Schemas it cannot encode fail when compiled, with the path:

```ts
compile(z.object({ meta: z.record(z.string(), z.unknown()) }));
// UnsupportedSchemaError at $.meta: record has no v0 encoding
```

Zod refinements and string/array length constraints are checked only with
`compile(EventResponse, { validate: true })`, on encode and decode. Validation is off by default.

## Columns and profiles

Arrays of records encode far better column-wise, which is a different plan for the same schema:

```ts
const columnar = compile(EventResponse, { plan: "columnar" });
```

Timestamps become deltas, integers bit-pack against the narrowest frame the column needs, exact-decimal numbers
travel as integer mantissas, enums become bit-packed indices, booleans pack into bitmaps, and text columns deflate
together when a deflate hook is available. The default plan is `"row"`.

A **profile** adds what only traffic can teach: the values that recur across *different* responses, the shape of
machine-made ids (`evt_000a1_9fa3` becomes two small integers), and columns that are functions of other columns,
none of which a compressor can see, because it only ever holds one response.

```ts
import { train } from "hyperfly";
import { toIR } from "hyperfly/zod";

const profile = train(toIR(EventResponse), [response]); // Supply representative samples.
const profiled = compile(EventResponse, { plan: "columnar", profile });
```

The dictionary is an out-of-band artifact: it ships once, not per request. On an audit-log route in the repo's
benchmark it costs 17 KB and pays for itself after twelve requests.

## Serving it

A peer decodes only an artifact it holds, so that has to be established before any bytes are sent. `hyperfly/http`
implements the negotiation:

```ts
import { CodecRegistry } from "hyperfly";
import { discovery, respond } from "hyperfly/http";

const registry = new CodecRegistry([codec]);
export default {
  fetch(request: Request) {
    return discovery(request, registry) ??
      respond(request, response, registry, { onFallback: console.warn });
  },
};
```

A client that holds nothing gets JSON plus a `Hyperfly-Offer` naming an artifact it could fetch; once it has it, the
same route can answer in binary. If the encoder refuses a value under its limits, `respond` answers JSON and calls
`onFallback(error)`. Responses carry `Vary: Hyperfly-Accept, Accept`.
A client opts out with `Accept: application/vnd.hyperfly;q=0`, even when it advertises a matching fingerprint.

For request bodies, `readBody` returns `{ ok: true, value }` or `{ ok: false, response }`; forward the latter:

```ts
import { readBody } from "hyperfly/http";

async function receive(request: Request) {
  const result = await readBody(request, registry, { maxBytes: 1 << 20 });
  if (!result.ok) return result.response;
  return respond(request, result.value, registry);
}
```

The first applicable rule in negotiation v1 §4 wins:

| Status | Request-body condition |
|---|---|
| 415 | Unsupported media type; absent Content-Type means JSON, and `+json` is accepted. |
| 413 | Body exceeds `maxBytes`, checked as bytes arrive; Content-Length can reject early. |
| 400 | Invalid binary envelope or `Hyperfly-Codec` disagrees with its fingerprint. |
| 415 + Hyperfly-Offer | Envelope fingerprint is unknown; an offer is included when a codec is registered. |
| 400 | Binary decode fails (including limits), JSON is malformed UTF-8/JSON, or the stream fails. |

## Node and Express

`negotiate` takes Hyperfly-Accept and a registry, with Accept in its options; `encodeFor` returns body and headers:

```ts
import { createServer } from "node:http";
import { encodeFor, negotiate, serveArtifact } from "hyperfly/http";

const header = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(", ") : value;

createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const artifact = serveArtifact(pathname, registry);
  if (artifact) {
    res.writeHead(artifact.status, artifact.headers);
    res.end(artifact.body);
    return;
  }
  const decision = negotiate(header(req.headers["hyperfly-accept"]), registry, {
    accept: header(req.headers.accept),
  });
  const { body, headers } = encodeFor(decision, response, { onFallback: console.warn });
  res.writeHead(200, headers);
  res.end(body);
}).listen(3000);
```

In Express 4 or 5, use the same calls with `req.headers` and `req.path`, set the returned status and headers, and
send binary as `Buffer.from(body)` so Express does not serialize the Uint8Array as JSON. Send a string body
directly. For body routes, copy headers into `Headers` and build a `Request` with an absolute URL, the method,
`Readable.toWeb(req)` as its body and `duplex: "half"`. Pass it to `readBody` before any Express body parser
consumes the stream; forward its response's status, headers and body when `ok` is false.

## Clients

Keep the registry between requests so an offered codec can serve the next one:

```ts
import { CodecRegistry } from "hyperfly";
import { acceptHeader, decodeResponse, fetchArtifact } from "hyperfly/http";

const registry = new CodecRegistry();
async function getEvents(url: string) {
  const result = await fetch(url, {
    headers: { "Hyperfly-Accept": acceptHeader(registry.fingerprints) },
  });
  const bytes = new Uint8Array(await result.arrayBuffer());
  const decoded = decodeResponse(result.headers.get("content-type"), bytes, registry);
  if (decoded.kind === "unknown-codec") throw new Error("Unadvertised codec");
  const offer = result.headers.get("hyperfly-offer");
  if (decoded.kind === "json" && offer) {
    const codec = await fetchArtifact(new URL(url).origin, offer);
    if (codec) registry.add(codec);
  }
  return decoded.value;
}
```

`fetchArtifact` verifies the fingerprint by compiling the parsed content, rather than trusting the received text. A
404 returns `undefined`: stay on JSON. `decodeResponse` reports `unknown-codec` for a binary fingerprint the client does not
hold; re-request without `Hyperfly-Accept` to get JSON. `loadArtifact(text, fingerprint, options)` performs the same
verification for artifact text obtained without fetching.

## Tenants and authorization

Use a separate `CodecRegistry` per tenant. Fingerprints identify schemas and trained dictionaries, so `.well-known`
discovery must apply the same authorization as the routes it describes. Never serve one tenant's artifact to
another. Route `discovery()` after your auth middleware, select that tenant's registry, and apply your authorization
policy to discovery caching as well. `fetchArtifact` accepts `headers` for credentials, plus `fetch`, `signal`,
`maxBytes`, `limits` and `pack` options.

Register the outgoing codec alongside the incoming one during rotation. Clients can list the new fingerprint first,
then the old codec can be removed once its traffic reaches zero. A new profile is a new fingerprint.

## Limits

`DecodeLimits` defaults follow wire v0 §6 and apply to encoding as well:

| Limit | Default | Meaning |
|---|---|---|
| `maxDepth` | 64 | Maximum enclosing struct, array and nullable nodes. |
| `maxItems` | 2^24 | Maximum elements in any one array, including fixed-length arrays. |
| `maxByteLength` | 2^28 | Maximum bytes in a string/bytes value or packed string payload. |
| `maxAmplification` | 32 | Bounds array counts against available bytes and the per-message item budget. |
| `maxTotalItems` | 2^24 | Maximum sum of all array element counts in one message. |

Pass overrides with `compile(schema, { limits })`, `compileIR(ir, { limits })`, or the `limits` option to
`loadArtifact` and `fetchArtifact`. Limits are local to each peer and are not negotiated or included in the
fingerprint. The per-message item budget is `min(maxTotalItems, maxAmplification × (body length + 1))`; columnar
arrays charge their row count once, not once per column; body length excludes the envelope header.

For dense routes such as width-zero telemetry batches or arrays of literals, raise `maxAmplification` and
`maxTotalItems` on **both peers** as needed. An encoder limit refusal over HTTP falls back to JSON and calls
`onFallback`. Separately, `readBody`'s `maxBytes` bounds incoming request bytes, including JSON; it defaults to
`DEFAULT_MAX_BODY_BYTES` from `hyperfly/http`, 1 MiB (1,048,576 bytes). `fetchArtifact` uses the same default byte
bound for artifact downloads.

## Errors

`HyperflyError` exposes `code` and carries `cause` when an underlying error exists. Subclasses: `EncodeError`,
`DecodeError`, `FingerprintMismatchError` (`expected`, `actual`) and `UnsupportedSchemaError` (`path`).

| ErrorCode | Meaning |
|---|---|
| `varint` | Overlong or non-minimal unsigned varint. |
| `range` | Number, enum index, dictionary code or derived value outside its allowed range. |
| `type` | Value has the wrong type, literal, enum member or fixed-array length. |
| `required` | A required field is missing on encode. |
| `utf8` | Invalid UTF-8 on decode or a lone surrogate on encode. |
| `float` | Non-finite float, negative-zero wire bits or non-minimal XOR float encoding. |
| `marker` | Invalid boolean/nullable marker, column mode, bit width or scale. |
| `bitmap` | Nonzero padding or inconsistent presence, null or exception bits. |
| `trailing` | Bytes remain after a complete body. |
| `truncated` | Input ends before a required byte or value. |
| `depth` | Nesting exceeds `maxDepth`. |
| `limit` | An item, byte, amplification or per-message budget bound is exceeded. |
| `header` | Envelope is too short, has bad magic or an unsupported wire major. |
| `fingerprint` | Fingerprint mismatch, invalid artifact fingerprint or failed artifact HTTP status other than 404. |
| `ir` | Invalid IR, profile or artifact structure/plan, or unreadable artifact content. |
| `packed` | Invalid compressed stream or decompressed length mismatch. |
| `unsupported` | Schema construct or required profile/packing capability is unsupported. |
| `json` | Malformed JSON; the underlying `SyntaxError` is `cause`. |
| `validation` | Zod `validate: true` failed; the underlying `ZodError` is `cause`. |

## Runtime support

ESM only: `hyperfly` for the codec, `hyperfly/zod` for Zod, `hyperfly/http` for HTTP helpers.

| Runtime | Codec | Packed column decode | `hyperfly/http` | Verification / needs |
|---|---|---|---|---|
| Node 18 | Yes | Yes | Yes | Supported; Web globals included. |
| Node 20 | Yes | Yes | Yes | Supported; Web globals included. |
| Node 22 | Yes | Yes | Yes | Supported; Web globals included. |
| Node 24 | Yes | Yes | Yes | Supported; Web globals included. |
| Bun | Yes | Yes | Yes | Tested in CI. |
| Deno | Yes | Yes | Yes | Supported; use npm imports. |
| Cloudflare Workers | Yes | Yes | Yes | Supported; bundle ESM. |
| Browsers | Yes | Yes | Yes | Supported; use a bundler or resolve npm imports. |

Node uses `node:zlib` when available through `process.getBuiltinModule`, with pure-JS bounded inflate otherwise.
Browsers and edge runtimes can decode packed string columns without `node:zlib`; without a deflate hook they encode
plain string columns. HTTP helpers use `fetch`, `Request`, `Response`, `Headers` and `ReadableStream` globals; Node
18 includes them. CI runs the TypeScript tests and the TypeScript/Python HTTP interop on Bun; it does not run a Node
or browser matrix.

## What it costs on the wire

Bytes per message, averaged over 500-message corpora, from `apps/bench` in the repo:

| route | JSON | JSON+Brotli | Protobuf | Hyperfly | Profiled |
|---|---|---|---|---|---|
| audit events | 12,687 | 2,512 | 7,190 | 2,013 | **574** |
| device telemetry | 7,994 | 1,422 | 2,007 | 755 | **542** |
| social feed | 6,863 | 2,294 | 4,396 | 1,871 | **1,466** |
| single order | 782 | 408 | 388 | 271 | **180** |
| OHLCV candles | 3,225 | 842 | 2,034 | **384** | **384** |

Read the spread, not the best row. Profiles are worth 71% on audit logs, where the
same actors recur on every request and the ids share one machine-made shape, and
nothing at all on candles, whose only string sits outside the array. The corpora
are synthetic, shaped like real routes but not captured from one, and no
production traffic has been measured yet.

## Guarantees

- **Exact-schema compatibility.** Any change to the schema or plan is a new
  fingerprint. A mismatch fails before the body is parsed; it never misreads.
- **Canonical output.** Encoding is canonical for a given implementation and version;
  re-encoding a decoded value reproduces the bytes that implementation emits.
- **Bounded decoding.** Nesting, item counts and byte lengths are limited. A
  per-message item budget bounds the sum of all array counts, and an amplification
  policy caps how many rows a hostile byte can demand, even when a constant
  column packs to zero bits.
- **One wire format.** [TypeScript](https://github.com/eliahilse/hyperfly/tree/main/packages/hyperfly),
  [Python](https://github.com/eliahilse/hyperfly/tree/main/python) and
  [Rust](https://github.com/eliahilse/hyperfly/tree/main/rust) are verified against
  the same golden vectors, and CI runs a TypeScript server against a Python client
  over real HTTP on every push.

## Reference

| API | Purpose |
|---|---|
| `compile(schema, options?)` | `hyperfly/zod`: Zod schema → codec; `plan`, `profile`, `limits`, `pack`, `validate`. |
| `compileIR(ir, options?)` | `hyperfly`: canonical IR → codec; same options except `validate`. |
| `train(ir, samples, options?)` | `hyperfly`: sampled responses → profile. Non-normative. |
| `CodecRegistry` | `hyperfly`: codecs by fingerprint; `add`, `get`, `remove`, `fingerprints`. |
| `negotiate` · `encodeFor` · `respond` | `hyperfly/http`: select a representation, encode it, or answer a fetch request. |
| `discovery` · `serveArtifact` | `hyperfly/http`: serve artifacts from a Request or pathname. |
| `readBody(request, registry, options?)` | `hyperfly/http`: bounded JSON/binary request decoding. |
| `acceptHeader(fingerprints)` | `hyperfly/http`: build Hyperfly-Accept in preference order. |
| `decodeResponse(contentType, bytes, registry)` | `hyperfly/http`: JSON/binary value or `unknown-codec`. |
| `fetchArtifact(base, fingerprint, options?)` | `hyperfly/http`: fetch, compile and verify an artifact; 404 → `undefined`. |
| `loadArtifact(text, fingerprint, options?)` | `hyperfly/http`: compile and verify artifact text; `limits`, `pack`. |
| `DEFAULT_MAX_BODY_BYTES` | `hyperfly/http`: default request/artifact byte bound, 1 MiB. |
| `codec.fingerprint` · `codec.artifact` | What identifies and describes a codec. |

The authorities are the specifications, not this implementation:
[wire v0](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md),
[columnar v5](https://github.com/eliahilse/hyperfly/blob/main/spec/plan-columnar-v5.md),
[negotiation v1](https://github.com/eliahilse/hyperfly/blob/main/spec/negotiation-v1.md).
A future implementation ports against the
[golden vectors](https://github.com/eliahilse/hyperfly/tree/main/spec/vectors), not
against this code.

## License

[Apache License 2.0](./LICENSE)
