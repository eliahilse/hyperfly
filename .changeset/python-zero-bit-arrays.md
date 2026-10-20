---
"@hyperfly/python": patch
---

Columnar bodies with arrays of empty fixed-length arrays now decode the same as in the TypeScript and Rust implementations. Python now accepts the bodies its own encoder writes and rejects truncated ones with `truncated`.
