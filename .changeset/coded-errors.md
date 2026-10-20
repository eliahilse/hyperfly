---
"hyperfly": minor
---

Malformed JSON, failed zod validation and invalid compile options now throw `HyperflyError` subclasses with codes `json`, `validation` and `options`. JSON and validation failures keep the original error as `cause`.
