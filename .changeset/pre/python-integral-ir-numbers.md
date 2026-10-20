---
"@hyperfly/python": patch
---

`compile_ir` now rejects IR and profiles with unknown keys, and accepts integral floats such as `2.0` or `-0.0` wherever an integer is expected, with the same fingerprint as the plain integer. A literal `0` also accepts a `-0.0` value.
