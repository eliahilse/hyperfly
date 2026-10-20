---
"hyperfly": patch
---

`respond` and `encodeFor` also fall back to JSON when the encoder refuses a value for exceeding `maxDepth`, as they already did for the other limits.
