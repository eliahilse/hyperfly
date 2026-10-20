---
"hyperfly": patch
---

`respond` and `discovery` answer HEAD, 204, 205 and 304 without a body; HTTP helpers, deflate hooks and `serializeArtifact` throw coded `HyperflyError`s. `readBody` answers bad bodies with 400, 413 or 415 and rejects only invalid options, `validate: true` checks apply once, and `hyperfly/package.json` is exported.
