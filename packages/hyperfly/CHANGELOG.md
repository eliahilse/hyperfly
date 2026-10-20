# hyperfly

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
