---
"@hyperfly/rust": patch
---

When a columnar array has several invalid values, encoding now reports the first one in value order, matching the TypeScript and Python packages.
