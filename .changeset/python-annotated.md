---
"@hyperfly/python": patch
---

Constrained types such as `list[conint(ge=0)]` and `Annotated[int, Field(ge=0)] | None` now compile with integer bounds preserved. Field names the wire cannot carry raise `UnsupportedSchemaError` with the field path.
A field whose custom grouped metadata carries integer bounds now includes those bounds in its schema, changing its fingerprint.
