---
"@hyperfly/python": patch
---

The pydantic `compile` accepts `profile=`, JSON fallback serializes pydantic models and enums, and float overflow raises `EncodeError` with code `float`. `Codec.fingerprint`, `artifact` and `plan` are now read-only.
