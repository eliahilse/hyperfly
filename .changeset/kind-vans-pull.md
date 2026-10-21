---
"hyperfly": patch
---

JSON fallback handles proxy `toJSON` hooks when runtime detection is available and reports invalid byte storage with value paths. Byte encoding ignores overridden typed-array properties so subclasses produce the bytes they contain.
