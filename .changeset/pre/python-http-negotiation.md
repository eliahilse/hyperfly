---
"@hyperfly/python": patch
---

`negotiate` honours an `http_accept` q=0 opt-out and `encode_for` falls back to JSON through `on_fallback` when the codec refuses a value. `decode_request` and `read_body` read bounded request bodies and raise `RequestError` with status 400, 413 or 415.
