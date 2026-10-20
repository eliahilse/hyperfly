---
"@hyperfly/python": patch
---

`compile_ir` and the pydantic `compile` reject malformed `limits`, `plan`, `pack` or `validate` options with a `HyperflyError` of code `options`, as the TypeScript package does.
