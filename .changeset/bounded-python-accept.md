---
"@hyperfly/python": patch
---

`parse_accept` now examines at most 32 `Hyperfly-Accept` entries and ignores uppercase or malformed fingerprints instead of normalising them.
