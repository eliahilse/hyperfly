---
"@hyperfly/python": patch
---

Nested integer bounds follow field validation, so values changed by field validators or supplied by unchecked integer defaults encode safely; affected fingerprints change. Unsupported schemas and wire field names raise `UnsupportedSchemaError`.
