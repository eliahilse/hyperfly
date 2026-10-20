---
"hyperfly": patch
---

`compileIR` now rejects IR and profiles with unknown keys, accepts `-0` as the literal or bound `0`, and reports any malformed JSON input as a `HyperflyError` with code `ir`, so every implementation accepts the same schemas.
