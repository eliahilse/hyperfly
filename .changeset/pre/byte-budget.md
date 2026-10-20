---
"hyperfly": minor
---

Decoding enforces a per-message byte budget on string and bytes values, `maxTotalBytes` and `maxByteAmplification`, so payloads that expand into large strings are refused with `limit`. Encoders count the same bytes, and HTTP falls back to JSON.
