---
"@hyperfly/python": patch
---

A small hostile body is now rejected in bounded time: the new `max_total_items` limit caps the items one body can declare across all its arrays, and the default `max_amplification` is now 32. Encoding refuses values that a decoder holding the same limits would reject.
