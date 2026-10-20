# hyperfly

Binary compression for typed APIs at the edge of entropy.

Your schema already fixes every field name, type, and bound. Your traffic already
reveals what the values usually look like. Hyperfly compiles both into a binary
protocol for one exact route — and speaks JSON to anything that hasn't been told.

> **Pre-release.** The wire format is specified and three implementations agree on
> it byte-for-byte, but nothing is stable yet. Expect breaking changes before 1.0.

```bash
npm install hyperfly@next zod
```

Pre-releases are published under the `next` tag. Zod 4 is needed only for `hyperfly/zod`; the codec and HTTP entry
points do not require it.

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
`compile(EventResponse, { validate: true })`, on encode and decode. Validation is off by default. Encode sends the
parsed value; decode checks the decoded value and returns it as decoded, so a value-changing check such as `overwrite`
applies once per round trip.

## Columns and profiles

Arrays of many records usually encode smaller column-wise, which is a different plan for the same schema:

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

The dictionary is part of the out-of-band artifact: it ships once, not per request. On an audit-log route in the
repo's benchmark the dictionary is estimated at 17 KB and pays for itself after about twelve requests; the estimate
excludes the rest of the artifact.

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
same route can answer in binary. Responses carry `Vary: Hyperfly-Accept, Accept`.
For HEAD requests and status 204, 205 or 304, `respond` sends the negotiated headers without encoding the value or
sending a body; `discovery` answers GET and HEAD and returns `undefined` for other methods.
A client opts out with `Accept: application/vnd.hyperfly;q=0`, even when it advertises a matching fingerprint.

### JSON fallback

When the encoder refuses a value under its [limits](#limits) (an `EncodeError` with code `limit` or `depth`),
`respond` and `encodeFor` send the same value as JSON with `Hyperfly-Offer` naming the codec, and call
`onFallback(error)`. The client reads it like any other JSON response. Any other `EncodeError` (`type`, `required`,
`range`, `validation`, ...) means the value does not match the schema; it is thrown, not answered as JSON. Pass
`enabled: false` to `respond` or `negotiate` to answer JSON without consulting the registry, as an operator switch
or to shed load.

### Request bodies

`readBody` returns `{ ok: true, value }` or `{ ok: false, response }`; forward the latter:

```ts
import { readBody, respond } from "hyperfly/http";

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
| 400 | Binary decode fails (including limits), JSON is malformed UTF-8/JSON, or the body stream cannot be read. |

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

In Express, the shortest path is to hand the fetch-style helpers a `Request` and copy their `Response` back:

```ts
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { Readable } from "node:stream";
import { readBody, respond, serveArtifact } from "hyperfly/http";

function toFetchRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
  // Node needs duplex for a streamed body; not every RequestInit type declares it yet
  const init: RequestInit & { duplex: "half" } = {
    method: req.method,
    headers,
    body: body as ReadableStream<Uint8Array> | undefined,
    duplex: "half",
  };
  return new Request(new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`), init);
}

async function send(res: ExpressResponse, response: Response) {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const app = express();
app.use((req, res, next) => {
  const artifact = serveArtifact(req.path, registry);
  if (!artifact) return next();
  res.status(artifact.status).set(artifact.headers).end(artifact.body);
});
app.get("/events", (req, res) => send(res, respond(toFetchRequest(req), response, registry)));
app.post("/events", async (req, res) => {
  const request = toFetchRequest(req);
  const result = await readBody<typeof response>(request, registry);
  await send(res, result.ok ? respond(request, result.value, registry) : result.response);
});
app.listen(3000);
```

Mount `readBody` routes before any Express body parser, which would consume the stream first. With
`negotiate`/`encodeFor` instead, send binary as `Buffer.from(body)`: Express serializes a bare `Uint8Array` as JSON.

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
  if (decoded.kind === "json" && offer && !registry.has(offer)) {
    // an offer is advisory: a failed upgrade leaves this client on JSON, not failing the request
    const codec = await fetchArtifact(new URL(url).origin, offer).catch((error: unknown) => {
      console.warn("hyperfly artifact fetch failed", error);
      return undefined;
    });
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

An artifact contains its schema and, when profiled, a dictionary trained on real responses: actor names, ids,
recurring values. Treat it as data from the routes it serves. Use a separate `CodecRegistry` per tenant, and put
`.well-known` discovery behind the same authentication and authorization as those routes:

```ts
import { CodecRegistry } from "hyperfly";
import { discovery, respond } from "hyperfly/http";

const registries = new Map<string, CodecRegistry>();
function registryFor(tenantId: string): CodecRegistry {
  let registry = registries.get(tenantId);
  if (!registry) registries.set(tenantId, (registry = new CodecRegistry(codecsFor(tenantId))));
  return registry;
}

async function handle(request: Request): Promise<Response> {
  const tenant = await authenticate(request);
  if (!tenant) return new Response(null, { status: 401 });
  const registry = registryFor(tenant.id);
  const artifact = discovery(request, registry);
  if (artifact) {
    if (artifact.ok) artifact.headers.set("Cache-Control", "private, max-age=31536000, immutable");
    return artifact;
  }
  return respond(request, await loadEvents(tenant), registry);
}
```

Here `codecsFor` stands for your own lookup of a tenant's codecs, such as one compiled with a profile trained on
that tenant's traffic. `discovery` marks a hit `public, max-age=31536000, immutable`, which suits a public schema.
For anything tenant-scoped, override it as above so a shared cache or CDN never hands one tenant's artifact to
another. Protected discovery does not hide everything: with a profile, a response's length still shows roughly
whether its values were dictionary hits, across requests (negotiation v1 §6). On the
client, `fetchArtifact` accepts `headers` for credentials, plus `fetch`, `signal`, `maxBytes`, `limits` and `pack`
options.

Register the outgoing codec alongside the incoming one during rotation. Clients can list the new fingerprint first,
then the old codec can be removed once its traffic reaches zero. A new profile is a new fingerprint.

## Limits

A few bytes of columnar or profiled body can describe millions of rows or megabytes of text, so a decoder bounds the
work any input can demand. `DecodeLimits` follow [wire v0 §6](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md)
and apply to encoding as well (`DEFAULT_LIMITS` holds the defaults):

| Limit | Default | Bounds |
|---|---|---|
| `maxDepth` | 64 | Enclosing struct, array and nullable nodes. |
| `maxItems` | 2^24 | Elements in any one array, including fixed-length arrays. |
| `maxByteLength` | 2^28 | Bytes in one string or bytes value, and the inflated size of one packed string column. |
| `maxAmplification` | 32 | Array counts per remaining body byte, and the item budget per body byte. |
| `maxTotalItems` | 2^24 | Item budget: the sum of every array count in one body. |
| `maxByteAmplification` | 64 | Byte budget per body byte. |
| `maxTotalBytes` | 2^26 | Byte budget: the decoded UTF-8 and bytes length of every string and bytes value in one body. |

The **item budget** is `min(maxTotalItems, maxAmplification × (body length + 1))`, where body length excludes the
envelope header; a columnar array charges its row count once, not once per column. The **byte budget** is
`min(maxTotalBytes, maxByteAmplification × (body length + 1))`, and counts the values a decoder reconstructs as
well as those it reads: enum members, literals, dictionary, grammar and derived values, and inflated string columns. A failed
bound is code `limit`, or `depth` for `maxDepth`.

Limits are local to each peer: they are not negotiated and not part of the fingerprint. A route that legitimately
ships denser payloads (long runs of constant columns, arrays of literals, strings that are mostly dictionary hits)
raises them on **both peers**, `maxAmplification` for items and `maxByteAmplification` for bytes:

```ts
import { fetchArtifact } from "hyperfly/http";

const limits = { maxAmplification: 1024, maxTotalItems: 2 ** 26, maxByteAmplification: 4096 };

const serverCodec = compile(EventResponse, { plan: "columnar", profile, limits });
const clientCodec = await fetchArtifact(origin, serverCodec.fingerprint, { limits });
```

The same `limits` option is accepted by `compileIR` and `loadArtifact`; unknown keys and values that are not
non-negative safe integers throw code `options`. Raising limits only on the server lets it send bodies the client
rejects. Raising them only on the client changes nothing: the server's encoder still refuses the value and answers
through the [JSON fallback](#json-fallback).

Separately, `readBody`'s `maxBytes` bounds incoming request bytes, JSON included, and answers 413 past it; it
defaults to `DEFAULT_MAX_BODY_BYTES` from `hyperfly/http`, 1 MiB (1,048,576 bytes). `fetchArtifact` applies the same
default to artifact downloads and throws code `limit` past it.

## Errors

Compiling, encoding, decoding and loading artifacts throw `HyperflyError` with a `code`; match on `code`, not on the
message. `EncodeError` and `DecodeError` say which direction failed, `FingerprintMismatchError` is a `DecodeError`
with `expected` and `actual`, and `UnsupportedSchemaError` carries the schema `path`. When an underlying error caused
it, such as the `SyntaxError` of malformed JSON, a `ZodError` or a failed inflate or deflate hook, that error is the standard
`cause`; an error that describes the input itself has none. A `maxBytes` that is not a non-negative safe integer is
code `options`. In `fetchArtifact`, a rejected `fetch` and an abort propagate unchanged; a failure while reading the
artifact body is code `ir`.

```ts
import { HyperflyError } from "hyperfly";

try {
  codec.decode(bytes);
} catch (error) {
  if (!(error instanceof HyperflyError)) throw error;
  if (error.code === "limit" || error.code === "depth") console.warn("over the decode limits", error.message);
  else console.warn(`malformed body (${error.code})`, error.cause ?? error.message);
}
```

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
| `limit` | `maxItems`, `maxByteLength`, an amplification bound, the item or byte budget, or a `maxBytes` download bound. |
| `header` | Envelope is too short, has bad magic or an unsupported wire major. |
| `fingerprint` | Fingerprint mismatch, invalid artifact fingerprint or failed artifact HTTP status other than 404. |
| `ir` | Invalid IR, profile or artifact structure/plan, or unreadable artifact content. |
| `packed` | Invalid compressed stream, decompressed length mismatch, or a failing or invalid deflate hook. |
| `unsupported` | Schema construct or required profile/packing capability is unsupported. |
| `json` | Malformed JSON or UTF-8 in `decodeResponse`, malformed artifact text, or a value the JSON fallback cannot encode; the underlying error, when there is one, is `cause`. |
| `validation` | Zod `validate: true` failed on encode or decode; the `ZodError` is `cause`. |
| `options` | Invalid compile, artifact, `train` or HTTP options, such as an unknown limit or an invalid `maxBytes`. |

## Entry points

ESM only, three entry points:

- `hyperfly`: the codec. `compileIR`, `CodecRegistry`, `train`, `defaultPackHooks`, `serializeArtifact`,
  `validateIR`, `validateProfile`, `DEFAULT_LIMITS`, the error classes, and the `Codec`, `CompileOptions`,
  `DecodeLimits`, `PackHooks`, `Profile`, `IRNode` and related types.
- `hyperfly/zod`: `compile` and `toIR` for Zod 4 schemas, with `InferOutput` and `ZodCompileOptions`. The only entry
  point that needs `zod`.
- `hyperfly/http`: negotiation (`negotiate`, `encodeFor`, `respond`, `parseAccept`, `acceptHeader`), bodies
  (`readBody`, `decodeResponse`), artifacts (`discovery`, `serveArtifact`, `fetchArtifact`, `loadArtifact`) and the
  header, media-type and `DEFAULT_MAX_BODY_BYTES` constants.

## Runtime support

| Runtime | Codec and `hyperfly/http` | Decodes packed string columns | Packs string columns on encode | Verified |
|---|---|---|---|---|
| Node 18 | Yes | Yes | No | Supported |
| Node 20 | Yes | Yes | From 20.16 | Supported |
| Node 22 | Yes | Yes | From 22.3 | Supported |
| Node 24 | Yes | Yes | Yes | Supported |
| Bun | Yes | Yes | Yes | Tested in CI |
| Deno 2 | Yes | Yes | Where `process.getBuiltinModule` exists | Supported; use `npm:` imports |
| Cloudflare Workers | Yes | Yes | Where `process.getBuiltinModule` exists | Supported; bundle ESM |
| Browsers | Yes | Yes | No | Supported; use a bundler |

Every runtime decodes packed string columns: where `node:zlib` is unavailable, a bundled pure-JS inflater with the
same output bounds takes over. Encoding packs only when `process.getBuiltinModule("node:zlib")` resolves; elsewhere
the encoder writes plain string columns, which are valid and decode everywhere, just larger. To pack where it would
not, pass a deflate hook and keep the default inflater:

```ts
import { deflateRawSync } from "node:zlib";
import { defaultPackHooks } from "hyperfly";

const pack = { ...defaultPackHooks(), deflate: (data: Uint8Array) => new Uint8Array(deflateRawSync(data)) };
const packed = compile(EventResponse, { plan: "columnar", pack });
```

`pack` replaces the default hooks as a whole, so a hook set without `inflate` cannot decode packed columns, and
`pack: false` disables both. HTTP helpers use the `fetch`, `Request`, `Response`, `Headers` and `ReadableStream`
globals, which Node 18 and later provide. CI runs the TypeScript tests and the TypeScript/Python HTTP interop on Bun;
it does not run a Node, Deno or browser matrix.

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

- **Exact-schema compatibility.** Any change to the canonical IR, the plan or the
  shared profile (not its advisory `hints`) is a new fingerprint. Zod refinements and string/array length constraints
  are not part of the IR, so they do not change it. A mismatch fails before the body
  is parsed; it never misreads.
- **Canonical output.** Encoding is canonical for a given implementation, version and set of pack hooks;
  decoding what it emitted and encoding the result again reproduces the same bytes.
- **Bounded decoding.** Nesting, item counts and byte lengths are limited. Per-body
  item and byte budgets bound the sum of all array counts and of all decoded string
  and bytes lengths, and amplification bounds cap how many rows or bytes a hostile
  byte can demand, even when a constant column packs to zero bits.
- **One wire format.** [TypeScript](https://github.com/eliahilse/hyperfly/tree/main/packages/hyperfly),
  [Python](https://github.com/eliahilse/hyperfly/tree/main/python) and
  [Rust](https://github.com/eliahilse/hyperfly/tree/main/rust) are verified against
  the same golden vectors, and CI runs a TypeScript server against a Python client
  over real HTTP on every pull request and every push to `main`.

## Reference

| API | Purpose |
|---|---|
| `compile(schema, options?)` | `hyperfly/zod`: Zod schema → codec; `plan`, `profile`, `limits`, `pack`, `validate`. |
| `compileIR(ir, options?)` | `hyperfly`: canonical IR → codec; same options except `validate`. |
| `train(ir, samples, options?)` | `hyperfly`: sampled responses → profile. Non-normative. |
| `DEFAULT_LIMITS` · `defaultPackHooks()` | `hyperfly`: the default [limits](#limits) and deflate/inflate hooks. |
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
