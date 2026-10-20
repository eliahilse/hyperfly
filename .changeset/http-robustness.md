---
"hyperfly": patch
---

HTTP helpers, the JSON fallback, deflate hooks and `serializeArtifact` now report failures as coded `HyperflyError`s, and `respond` and `discovery` handle HEAD requests and bodyless statuses. Zod codecs compiled with `validate: true` return decoded values as decoded, so a value-changing check applies once per round trip.
