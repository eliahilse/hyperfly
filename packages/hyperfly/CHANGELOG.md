# hyperfly

## 1.0.0

### Major Changes

- 6880138: First stable release of the TypeScript codec, Zod adapter (`hyperfly/zod`) and HTTP helpers (`hyperfly/http`). The public API and wire format stay compatible throughout 1.x per [STABILITY.md](https://github.com/eliahilse/hyperfly/blob/main/STABILITY.md).

### Minor Changes

- 57ef0a3: `NegotiateOptions.accept` is now `httpAccept`, `WellKnownResponse` is now `ArtifactResponse`, `FetchHandlerOptions` is now `RespondOptions`, and `onFallback` moves to `EncodeOptions` with `(error, "encoder-limit")`. JSON negotiations and `readBody` refusals carry a `reason` (`FallbackReason`, `RequestRefusal`), and `CodecRegistry<T>` types its codecs.
- 1508d69: JSON fallback preserves bytes as canonical padded base64 and decodes values using the first registered codec, with consistent request and response failures. Artifact loading reports unreadable responses and malformed JSON with the `artifact` error code.
- c9565d7: `DecodeLimits` is renamed to `Limits`, since the same bounds apply to encoding and decoding.
- f9863e0: Requires Node.js 22 or later. The `hyperfly`, `hyperfly/zod` and `hyperfly/http` entry points no longer support Node.js 18 or 20.
- fc9d2ca: `train` now rejects invalid `minOccurrences`, `maxEntries` and options values with a `HyperflyError` of code `options`, and clamps `minOccurrences` 0 to 1 and `maxEntries` above 16383 to 16383.

### Patch Changes

- 9a33ecb: A struct value must be an object tagged "[object Object]", class instances included, so a typed array, `Map`, `Set`, `Date` or boxed primitive fails with `type` as in Python and Rust. A `bytes` value may come from another realm.
- de7f289: `respond` and `discovery` answer HEAD, 204, 205 and 304 without a body; HTTP helpers, deflate hooks and `serializeArtifact` throw coded `HyperflyError`s. `readBody` answers bad bodies with 400, 413 or 415 and rejects only invalid options, `validate: true` checks apply once, and `hyperfly/package.json` is exported.
- ef98f2a: Packed string columns of any size now decode in browsers and edge runtimes without node:zlib, matching node:zlib when `maxByteLength` is raised past 512 MiB.
- fa55ea3: Schemas nested up to the 512-level artifact limit now compile on every entry point, and deeper schemas are rejected with code `ir` instead of exhausting the stack.
- ba9d30f: Every public export now has JSDoc, including defaults, error codes and spec references. The README links the stability and security policies.
- a11cc63: `readBody` and `fetchArtifact` now read bodies correctly from streams that reuse one buffer across chunks.

## 1.0.0-alpha.1

### Minor Changes

- 6efe5d2: Decoding enforces a per-message byte budget on string and bytes values, `maxTotalBytes` and `maxByteAmplification`, so payloads that expand into large strings are refused with `limit`. Encoders count the same bytes, and HTTP falls back to JSON.
- 83dddd5: Clients can bootstrap from a `Hyperfly-Offer` with `fetchArtifact` or `loadArtifact`, which verify the artifact fingerprint before returning a codec.
- 7557279: Malformed JSON, failed zod validation and invalid compile options now throw a `HyperflyError` with code `json`, `validation` or `options`, keeping the original error as `cause` where there is one.
- 7bc09b6: The new `maxTotalItems` limit caps the array items in one message, so nested arrays can't turn a small hostile body into a huge allocation. `maxAmplification` now defaults to 32; routes with long constant runs raise it on both peers.
- 3c07323: `readBody` caps request bodies (`maxBytes`, default `DEFAULT_MAX_BODY_BYTES`) and answers bad bodies with 400, 413 or 415 instead of throwing. `respond` honours `Accept` q=0, sends `Vary: Hyperfly-Accept, Accept`, and falls back to JSON through `onFallback` when the encoder refuses a value.
- 098b25b: Packed string columns now decode in browsers, edge runtimes and older Node versions through a built-in inflater, so `defaultPackHooks()` always provides `inflate`.
- a2c58b8: `CodecRegistry` accepts codecs compiled from typed schemas, and `DEFAULT_LIMITS` is frozen (pass `limits` instead of mutating it). The root entry no longer exports `serializeNode`, `fingerprintOf`, `toHex`, `sha256`, `columnarEligible`, `enumerateColumns`, `MAX_DICT_ENTRIES`, `INT_MAX`, `INT_MIN`, `MAGIC`, `HEADER_SIZE` or `WIRE_VERSION`.

### Patch Changes

- 2f12a19: `parseAccept` now examines at most 32 entries of a `Hyperfly-Accept` header and ignores uppercase fingerprints, so a padded or malformed header costs a bounded amount of work.
- 50b1b09: `compileIR` now rejects IR and profiles with unknown keys, accepts `-0` as the literal or bound `0`, and reports any malformed JSON input as a `HyperflyError` with code `ir`, so every implementation accepts the same schemas.
- 308000a: `respond` and `encodeFor` also fall back to JSON when the encoder refuses a value for exceeding `maxDepth`, as they already did for the other limits.
- 1c9ed57: `readBody` and `fetchArtifact` reject an invalid `maxBytes` with a `HyperflyError` of code `options`, like compile options.
- 8360bbd: The package README now covers the decode limits and how to raise them on both peers, the JSON fallback, every error code, the three entry points, runtime support, an Express server and per-tenant artifact serving.
- c18d4e3: `compileIR` rejects IR with missing or mistyped nodes, members or fields, and struct fields whose `optional` or `nullable` flag is not a boolean, with a `HyperflyError` of code `ir` instead of a `TypeError`.
