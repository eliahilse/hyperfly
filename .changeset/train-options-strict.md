---
"hyperfly": minor
---

`train` now rejects invalid `minOccurrences`, `maxEntries` and options values with a `HyperflyError` of code `options`, and clamps `minOccurrences` 0 to 1 and `maxEntries` above 16383 to 16383.
