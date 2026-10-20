---
"hyperfly": patch
---

Packed string columns of any size now decode in browsers and edge runtimes without node:zlib, matching node:zlib when `maxByteLength` is raised past 512 MiB.
