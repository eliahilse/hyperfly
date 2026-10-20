---
"@hyperfly/python": patch
---

Integral floats such as `1.0` now encode in int fields and int literals as they do in TypeScript. Schemas nested up to the 512-level artifact limit compile everywhere, deeper ones raise code `ir` instead of hitting Python's recursion limit, and a profile must be JSON data.
