---
"@hyperfly/rust": patch
---

Decoding a columnar body keeps each string and enum column in one buffer until every column has decoded, so a body that fails partway through needs about half the memory it did. The encoder now refuses arrays its decoder would reject under the one-bit floor.
