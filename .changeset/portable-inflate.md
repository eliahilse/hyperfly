---
"hyperfly": minor
---

Packed string columns now decode in browsers, edge runtimes and older Node versions through a built-in inflater, so `defaultPackHooks()` always provides `inflate`.
