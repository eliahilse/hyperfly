---
"hyperfly": minor
---

JSON fallback preserves bytes as canonical padded base64 and decodes values using the first registered codec, with consistent request and response failures. Artifact loading reports unreadable responses and malformed JSON with the `artifact` error code.
