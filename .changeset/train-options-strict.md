---
"hyperfly": minor
---

The `train` API now reports invalid `minOccurrences`, `maxEntries`, and options objects as a `HyperflyError` with code `options`, making training configuration mistakes easier to diagnose.
