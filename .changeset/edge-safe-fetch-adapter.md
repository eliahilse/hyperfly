---
"hyperfly": minor
---

`readBody` caps request bodies (`maxBytes`, default `DEFAULT_MAX_BODY_BYTES`) and answers bad bodies with 400, 413 or 415 instead of throwing. `respond` honours `Accept` q=0, sends `Vary: Hyperfly-Accept, Accept`, and falls back to JSON through `onFallback` when the encoder refuses a value.
