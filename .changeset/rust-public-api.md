---
"@hyperfly/rust": patch
---

The crate root exports only the codec surface, with internal modules private and every public item documented. `Codec::artifact()` and `Codec::fingerprint()` replace the public fields with read-only accessors.
