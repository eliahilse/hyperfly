---
"hyperfly": patch
---

Struct values must now be plain objects, so a typed array, `Map`, `Set`, `Date` or boxed primitive fails with `type` as in Python and Rust. A `bytes` value may come from another realm.
