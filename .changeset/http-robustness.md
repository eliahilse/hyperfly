---
"hyperfly": patch
---

`respond`, `discovery`, `readBody`, `decodeResponse` and `encodeFor` now report bad input as a `HyperflyError` with a code, and `respond` and `discovery` answer HEAD requests and 204, 205 and 304 statuses without a body. `readBody` always returns a promise, which rejects on invalid options. Errors from `pack.deflate` hooks and invalid input to `serializeArtifact` are coded too. Zod codecs compiled with `validate: true` return decoded values as decoded, so a check that changes the value applies once per round trip. The package now exports `hyperfly/package.json`.
