---
"@hyperfly/python": patch
---

`Codec` is generic and `hyperfly.pydantic.compile` returns a public `ModelCodec`, a `Codec` subclass that type-checks in a `CodecRegistry` and the HTTP helpers; `PackHooks` and `validate_profile` are exported. `Codec(...)` now takes keyword arguments and checks them like `compile_ir`, and `train` raises code `options` for samples that are not a list or tuple and for thresholds that are not non-negative integers.
