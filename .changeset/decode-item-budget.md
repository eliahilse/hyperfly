---
"hyperfly": minor
---

Decoders now cap the total number of array items in one message with the new `maxTotalItems` limit, so nested or sibling arrays can no longer turn a small hostile body into a huge allocation. The default `maxAmplification` is now 32; a route that ships long runs of constant rows raises it on both peers.
