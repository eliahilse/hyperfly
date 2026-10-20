---
"@hyperfly/rust": patch
---

Compiling an IR whose artifact nests deeper than 512 levels fails with `ir` instead of risking a stack overflow, matching the TypeScript and Python packages.
