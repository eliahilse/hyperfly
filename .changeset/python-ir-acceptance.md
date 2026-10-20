---
"@hyperfly/python": patch
---

`compile_ir` now rejects every malformed IR with `HyperflyError` code `ir`, including explicit `None` bounds and lengths and non-boolean field flags, matching the TypeScript package.
