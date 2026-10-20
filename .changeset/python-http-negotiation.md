---
"@hyperfly/python": patch
---

`negotiate` takes the HTTP `accept` header so `application/vnd.hyperfly;q=0` opts out of binary, responses vary on `Hyperfly-Accept, Accept`, and `encode_for` answers in JSON and calls `on_fallback` when the codec refuses a value under its limits. `decode_request` and `read_body` read a bounded request body and raise `RequestError` with status 400, 413 or 415 as negotiation v1 section 4 orders them.
