---
"hyperfly": minor
---

`readBody` now caps request bodies (`maxBytes`, default `DEFAULT_MAX_BODY_BYTES`) and answers malformed or unsupported bodies with 400, 413 or 415 instead of throwing. `respond` honours `Accept` q=0, always keeps `Vary: Hyperfly-Accept, Accept`, and falls back to JSON (reported through `onFallback`) when the encoder refuses a value under its limits.
