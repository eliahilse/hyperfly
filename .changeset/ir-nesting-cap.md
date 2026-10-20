---
"hyperfly": patch
---

Schemas nested up to the 512-level artifact limit now compile on every entry point, and deeper schemas are rejected with code `ir` instead of exhausting the stack.
