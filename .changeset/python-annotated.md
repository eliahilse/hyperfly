---
"@hyperfly/python": patch
---

Constrained types such as `list[conint(ge=0)]` and `Annotated[int, Field(ge=0)] | None` now compile with their integer bounds, including bounds from custom grouped metadata, which changes those schemas' fingerprints. Field names the wire cannot carry raise `UnsupportedSchemaError`.
