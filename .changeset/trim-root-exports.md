---
"hyperfly": minor
---

`CodecRegistry` accepts codecs compiled from typed schemas, and `DEFAULT_LIMITS` is frozen (pass `limits` instead of mutating it). The root entry no longer exports `serializeNode`, `fingerprintOf`, `toHex`, `sha256`, `columnarEligible`, `enumerateColumns`, `MAX_DICT_ENTRIES`, `INT_MAX`, `INT_MIN`, `MAGIC`, `HEADER_SIZE` or `WIRE_VERSION`.
