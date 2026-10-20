---
"hyperfly": patch
---

`parseAccept` now examines at most 32 entries of a `Hyperfly-Accept` header and ignores uppercase fingerprints, so a padded or malformed header costs a bounded amount of work.
