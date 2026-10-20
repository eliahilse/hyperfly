---
"@hyperfly/python": patch
---

Nested integer bounds use the Pydantic int schema that produces the field's stored value, so validated values encode safely after validators; affected fingerprints change. Unsupported integer schemas and wire field names raise `UnsupportedSchemaError`.
