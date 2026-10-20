---
"@hyperfly/python": patch
---

`compile_ir`, the pydantic `compile`, `read_body` and `decode_request` reject malformed `limits`, `plan`, `pack`, `validate` or `max_bytes` options with a `HyperflyError` of code `options`, as the TypeScript package does.
