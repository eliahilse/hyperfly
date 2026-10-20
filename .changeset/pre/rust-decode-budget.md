---
"@hyperfly/rust": patch
---

Decoding now charges every array against a per-body item budget, so a small hostile body is rejected in bounded time. The new `max_total_items` limit caps that budget, and the default `max_amplification` is now 32.
