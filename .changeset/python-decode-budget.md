---
"@hyperfly/python": patch
---

Small hostile bodies now fail fast: the new `max_total_items` limit caps the items one body declares across its arrays, and `max_amplification` defaults to 32. Encoders refuse what a same-limits decoder rejects, and columnar decoding keeps columns packed until the body decodes.
