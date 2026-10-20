---
"@hyperfly/rust": patch
---

Decoding a packed string column no longer allocates its declared size up front, so a few hostile bytes cannot force a 256 MiB allocation.
