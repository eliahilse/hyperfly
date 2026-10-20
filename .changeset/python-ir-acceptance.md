---
"@hyperfly/python": patch
---

`compile_ir` rejects malformed IR with `HyperflyError` code `ir`, including explicit `None` bounds and lengths and non-boolean field flags, matching the TypeScript package.
