---
"hyperfly": minor
---

Malformed JSON, failed zod validation and invalid compile options now throw a `HyperflyError` with code `json`, `validation` or `options`, keeping the original error as `cause` where there is one.
