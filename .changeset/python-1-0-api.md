---
"@hyperfly/python": patch
---

`Codec` is generic, `hyperfly.pydantic.compile` returns a `ModelCodec` that works anywhere a `Codec` does, and `PackHooks` and `validate_profile` are exported. `Codec(...)` now takes keyword arguments checked like `compile_ir`, and `train` raises `options` for invalid samples or thresholds.
