# @hyperfly/python

## 1.0.1

### Patch Changes

- 0093656: Decode Python payloads faster while preserving wire compatibility and validation errors. Encode behavior and supported Python versions remain unchanged.

## 1.0.0

### Major Changes

- 6880138: First stable release of the Python codec, Pydantic adapter and HTTP helpers. The public API and wire format stay compatible throughout 1.x per [STABILITY.md](https://github.com/eliahilse/hyperfly/blob/main/STABILITY.md).

### Patch Changes

- fd2998a: `Codec` is generic, `hyperfly.pydantic.compile` returns a `ModelCodec` that works anywhere a `Codec` does, and `PackHooks` and `validate_profile` are exported. `Codec(...)` now takes keyword arguments checked like `compile_ir`, and `train` raises `options` for invalid samples or thresholds.
- 99535ed: Nested integer bounds follow field validation, so values changed by field validators encode safely; affected fingerprints change. Unvalidated defaults keep declared bounds and can raise `range`; unsupported schemas, recursive models and wire field names raise `UnsupportedSchemaError`.
- 54eaaf4: JSON bodies decoded under a codec are converted and checked against its schema. JSON fallback writes bytes at declared bytes positions and in plain containers as standard padded base64; `offer=""` suppresses the offer.
- eb7c7f8: Integral floats such as `1.0` now encode in int fields and int literals as they do in TypeScript. Schemas nested up to the 512-level artifact limit compile, deeper ones raise code `ir` instead of hitting Python's recursion limit, and a profile must be JSON data.
- 13d0583: HTTP JSON fallback now encodes declared bytes beneath field validators as standard padded base64, so binary payloads round trip reliably, including non-UTF-8 data. Custom serializers keep their existing output.
- f41b658: The README documents the pydantic type mapping and int bound rules, a raw IR example, the client helpers, JSON conversion under a codec and the public API.
- 76d97f7: Columnar bodies with arrays of empty fixed-length arrays now decode the same as in the TypeScript and Rust implementations. Python now accepts the bodies its own encoder writes and rejects truncated ones with `truncated`.

## 1.0.0-alpha.1

### Patch Changes

- 45cb2ad: `parse_accept` now examines at most 32 `Hyperfly-Accept` entries and ignores uppercase or malformed fingerprints instead of normalising them.
- 1a47e9c: The new `max_total_bytes` and `max_byte_amplification` limits cap the decoded bytes of every string and bytes value in one body, including literals, enum members and profile values, so a small body can no longer decode to a huge one.
- 1a47e9c: Small hostile bodies now fail fast: the new `max_total_items` limit caps the items one body declares across its arrays, and `max_amplification` defaults to 32. Encoders refuse what a same-limits decoder rejects, and columnar decoding keeps columns packed until the body decodes.
- 73e725e: A malformed JSON body now raises `DecodeError` with code `json`, and a failed model validation raises `EncodeError` or `DecodeError` with code `validation`; the original `json.JSONDecodeError` or pydantic `ValidationError` is wrapped and stays reachable through `__cause__`.
- d7b49a7: The pydantic `compile` accepts `profile=`, JSON fallback serializes pydantic models and enums, and float overflow raises `EncodeError` with code `float`. `Codec.fingerprint`, `artifact` and `plan` are now read-only.
- 73e725e: `negotiate` honours an `http_accept` q=0 opt-out and `encode_for` falls back to JSON through `on_fallback` when the codec refuses a value. `decode_request` and `read_body` read bounded request bodies and raise `RequestError` with status 400, 413 or 415.
- 50b1b09: `compile_ir` now rejects IR and profiles with unknown keys, and accepts integral floats such as `2.0` or `-0.0` wherever an integer is expected, with the same fingerprint as the plain integer. A literal `0` also accepts a `-0.0` value.
- c18d4e3: `compile_ir` rejects malformed IR with `HyperflyError` code `ir`, including explicit `None` bounds and lengths and non-boolean field flags, matching the TypeScript package.
- d902b74: `compile_ir`, the pydantic `compile`, `read_body` and `decode_request` reject malformed `limits`, `plan`, `pack`, `validate` or `max_bytes` options with a `HyperflyError` of code `options`, as the TypeScript package does.
- f781c7f: The `hyperfly` distribution is marked typed with `py.typed`, lists its supported Python versions and project links, and leaves tests out of the sdist.
- df3e546: Adds `train`, the reference profile trainer, so Python services can build columnar profiles from their own traffic. It produces the same profiles as the TypeScript trainer.
