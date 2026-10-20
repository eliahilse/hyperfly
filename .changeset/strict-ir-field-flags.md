---
"hyperfly": patch
---

`compileIR` rejects IR with missing or mistyped nodes, members or fields, and struct fields whose `optional` or `nullable` flag is not a boolean, with a `HyperflyError` of code `ir` instead of a `TypeError`.
