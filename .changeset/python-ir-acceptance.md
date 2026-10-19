---
"@hyperfly/python": patch
---

`compile_ir` now rejects every malformed IR with `UnsupportedSchemaError` code `ir`, including explicit `None` bounds and lengths, matching the TypeScript package.
