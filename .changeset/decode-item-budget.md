---
"hyperfly": minor
---

The new `maxTotalItems` limit caps the array items in one message, so nested arrays can't turn a small hostile body into a huge allocation. `maxAmplification` now defaults to 32; routes with long constant runs raise it on both peers.
