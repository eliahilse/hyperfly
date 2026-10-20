---
"@hyperfly/python": patch
---

Nested integer bounds follow field validation, so values changed by field validators encode safely; affected fingerprints change. Unvalidated defaults keep declared bounds and can raise `range`; unsupported schemas, recursive models and wire field names raise `UnsupportedSchemaError`.
