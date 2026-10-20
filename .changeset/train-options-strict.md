---
"hyperfly": minor
---

The `train` API accepts non-negative integer options, clamps `minOccurrences` from 0 to 1, and clamps `maxEntries` above 16383 to 16383, including integers beyond the safe integer range. Invalid values and options objects raise a `HyperflyError` with code `options`, including when proxy traps throw values that cannot be inspected.
