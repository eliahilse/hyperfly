---
"@hyperfly/python": patch
---

Nested and grouped integer constraints compile with their bounds, and repeated bounds follow Pydantic: the last of each kind wins, changing affected schemas' fingerprints. Field names the wire cannot carry raise `UnsupportedSchemaError`.
