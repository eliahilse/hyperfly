---
"hyperfly": minor
---

Simplify the root API and let `CodecRegistry` accept typed codecs. Remove `serializeNode`, `fingerprintOf`, `toHex`, `sha256`, `columnarEligible`, `enumerateColumns`, `MAX_DICT_ENTRIES`, `INT_MAX`, `INT_MIN`, `MAGIC`, `HEADER_SIZE`, and `WIRE_VERSION` from the root exports. `DEFAULT_LIMITS` is now frozen; pass `limits` to `compileIR` or `compile` instead of mutating it.
