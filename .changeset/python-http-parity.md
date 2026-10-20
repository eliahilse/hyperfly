---
"@hyperfly/python": patch
---

JSON fallback validates codec schemas, restores bytes from base64 and integral numbers as ints, and reports JSON failures consistently. Bytes values in models and nested containers use standard padded base64; `offer=""` suppresses the offer.
