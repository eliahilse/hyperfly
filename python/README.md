# hyperfly (Python)

Python implementation of the hyperfly wire format, with a Pydantic adapter.
The authorities are `spec/wire-v0.md`, `spec/plan-columnar-v2.md`, and the
golden vectors — this implementation reproduces them byte-for-byte, and the
test suite proves it against the same files the TypeScript reference uses.

```python
from hyperfly.pydantic import compile

codec = compile(CandleResponse)
data = codec.encode(response)
value = codec.decode(data)
```

Pre-release; nothing is published to PyPI yet.
