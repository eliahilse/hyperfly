---
"@hyperfly/python": patch
---

JSON bodies decoded under a codec are converted and schema checked, restoring bytes from base64 and ints from integral numbers; failures raise `json` or a 400. Bytes are written as base64; `offer=""` suppresses the offer.
