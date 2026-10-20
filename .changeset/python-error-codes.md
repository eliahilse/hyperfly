---
"@hyperfly/python": patch
---

A malformed JSON body now raises `DecodeError` with code `json`, and a failed model validation raises `EncodeError` or `DecodeError` with code `validation`; the original `json.JSONDecodeError` or pydantic `ValidationError` is wrapped and stays reachable through `__cause__`.
