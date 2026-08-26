# Hyperfly wire format — v0

Status: draft. This document and the vectors under `spec/vectors/` are the
authorities on the format. The TypeScript package is a reference
implementation; any future implementation (Rust, Python) must reproduce the
vectors byte-for-byte. Where an implementation and this document disagree, the
document wins.

v0 is the schema-compiled row layout: no profiles, no entropy coding, no
dictionaries, no columnar or delta transforms. Those arrive as new plans (and
therefore new fingerprints), not as changes to v0.

## 1. Model

A **schema IR** describes the shape of a value. A **plan** describes how that
shape is laid out in bytes (v0 defines exactly one plan: `row` version 1). IR
plus plan plus wire major version form the **codec artifact**. The artifact is
canonically serialized and fingerprinted; the fingerprint — not the schema —
is what peers use to select a decoder.

Compatibility is exact: any change to the IR or plan produces a new artifact
and a new fingerprint. There is no in-band evolution, no unknown-field
skipping, and no promise of reading an unfamiliar version. A peer that does
not recognize a fingerprint falls back to JSON at the protocol layer above.

## 2. Envelope

```
offset  size  field
0       2     magic 0x68 0x66 ("hf")
2       1     wire major, 0x01
3       16    artifact fingerprint
19      —     body
```

`encode()` produces one bounded buffer. There is no body length field;
framing is the transport's job (HTTP bodies are already framed). Concatenating
envelopes requires an outer frame and is out of scope for v0.

Decoders MUST verify magic, major, and fingerprint before reading any body
byte, and MUST reject trailing bytes after a complete body.

## 3. Primitives

### 3.1 ULEB128 (`uvarint`)

Little-endian base-128. Each byte holds 7 value bits, low group first; the
high bit marks continuation.

- Maximum encoded length in v0: **8 bytes** (56 value bits).
- Non-minimal (overlong) encodings MUST be rejected: the final byte MUST be
  non-zero unless the total length is 1.
- The decoded value MUST fit the field's domain (§3.3); out-of-domain values
  MUST be rejected.

### 3.2 ZigZag (`svarint`)

`zigzag(v) = 2v` for `v ≥ 0`, `-2v - 1` for `v < 0`, then ULEB128. Implement
in 64-bit or arbitrary-precision integers; IEEE-754 doubles are not exact over
the full domain.

### 3.3 Integer domain

v0 integers live in `[-(2^53 - 1), 2^53 - 1]` (JSON-safe integers). Bound
offsets (§4.4) may reach `2^54 - 2`, which fits 56 bits.

### 3.4 Fixed-width values

All fixed-width values are **little-endian**. `float64` is IEEE 754 binary64.

### 3.5 Bitmaps

`ceil(n/8)` bytes for `n` flags. Flag `i` lives in byte `⌊i/8⌋`, bit `i mod 8`
(LSB-first). Padding bits MUST be zero; decoders MUST reject nonzero padding.

## 4. Node encodings (plan `row` v1)

### 4.1 `bool`

One byte: `0x00` false, `0x01` true. Decoders MUST reject other values.

### 4.2 `literal`

Zero bytes. The value is part of the artifact. v0 literal values are strings,
booleans, `null`, or JSON-safe integers (non-integer numeric literals are not
representable in v0).

### 4.3 `enum { members }`

ULEB128 index into `members`, in declared order. Index MUST be
`< members.length`. Members are unique, non-empty, strings only. Declared
order is canonical; reordering members is a new artifact.

### 4.4 `int { min?, max? }`

- If `min` is declared: `uvarint(value - min)` using exact integer arithmetic.
- Otherwise: `svarint(value)`.
- Declared bounds are validated on encode AND decode; out-of-bounds MUST be
  rejected on both sides.

### 4.5 `float64`

8 bytes LE. Values MUST be finite; NaN and ±Infinity are rejected on encode
and decode. `-0` is canonicalized to `+0` on encode; decoders MUST reject a
negative-zero bit pattern.

### 4.6 `string`

`uvarint` byte length, then strict UTF-8. Encoders MUST reject lone
surrogates. Decoders MUST reject invalid UTF-8 (no replacement characters).

### 4.7 `bytes`

`uvarint` length, then raw bytes.

### 4.8 `array { element, length? }`

- Fixed (`length` declared): exactly `length` elements, no count on the wire.
- Variable: `uvarint` count, then elements.

### 4.9 `nullable { inner }`

One byte: `0x00` null (nothing follows), `0x01` value follows. Other values
rejected. `nullable(nullable(T))` is invalid IR. Inside a struct, prefer the
field flag (§4.10), which uses the bitmap instead.

### 4.10 `struct { fields }`

Field order is declared order and is canonical.

**Portable field names.** A field name MUST NOT be `__proto__`, and MUST NOT be
a decimal array index (`0`, or a digit string with no leading zero whose value
is below 2^32 − 1). Some host languages reorder integer-index object keys and
trap `__proto__` assignment, so such names cannot round-trip or fingerprint
identically everywhere. Field names, enum members, and string literals MUST
also be well-formed Unicode: a lone surrogate has no portable representation
and MUST be rejected at IR validation.

**Unambiguous null.** `nullable(literal null)`, and a field carrying the
`nullable` flag over a `literal null` type, are both invalid: they give one
value two wire encodings. Each field has `optional` and
`nullable` flags. Layout:

1. **Presence bitmap** over the optional fields, in field order. Bit set =
   present.
2. **Null bitmap** over the nullable fields, in field order — one bit per
   nullable field regardless of presence. Bit set = null. For an absent
   field the bit MUST be zero.
3. Field values, in field order, for fields that are present and not null.

Absent and null are distinct states and MUST NOT collapse. A required field
cannot be absent; a non-nullable field cannot be null; violations are encode
errors, and the corresponding wire states are decode errors.

## 5. Canonical artifact serialization and fingerprint

The canonical form is UTF-8 JSON text produced by a spec-defined serializer —
this is NOT generic JSON canonicalization:

- No whitespace.
- Object keys in the fixed orders given below; omitted keys are absent, never
  `null`.
- Integers in base 10, no exponent, no leading zeros, `-` for negatives only.
- Strings escape only `"` as `\"`, `\` as `\\`, and control characters below
  U+0020 as `\u00XX` (lowercase hex). Everything else is raw UTF-8.

Key orders:

```
artifact  {"wire":1,"plan":{"layout":"row","version":1},"ir":<node>}
bool      {"kind":"bool"}
int       {"kind":"int","min":M,"max":X}          min/max omitted if absent
float64   {"kind":"float64"}
string    {"kind":"string"}
bytes     {"kind":"bytes"}
literal   {"kind":"literal","value":V}
enum      {"kind":"enum","members":[...]}
nullable  {"kind":"nullable","inner":<node>}
array     {"kind":"array","element":<node>,"length":N}   length omitted if variable
struct    {"kind":"struct","fields":[{"name":S,"type":<node>,"optional":true,"nullable":true},...]}
          optional/nullable omitted when false
```

**Fingerprint** = first 16 bytes of `SHA-256(canonical bytes)`, rendered as
32 lowercase hex characters where textual.

## 6. Decoder limits

Implementations MUST enforce configurable limits with these v0 defaults:

- `maxDepth` 64 (structs, arrays, nullable all count),
- `maxItems` 2^24 per array,
- `maxByteLength` 2^28 per string/bytes value,
- `maxAmplification` 4096: an array count above
  `maxAmplification × (remaining bytes + 1)` is rejected. Compressed layouts
  can legitimately describe many rows with almost no bytes, so input length
  alone cannot bound a count; this caps the work one hostile byte can demand
  instead. Row-encoded arrays satisfy a stricter bound for free — every row
  consumes at least one bit, so a count beyond the remaining bits is
  unpayable and MUST be rejected.

Truncation anywhere is an error. Errors are errors — never best-effort
partial values.

## 7. Frozen decisions (deliberately unimplemented)

- Little-endian everywhere; no big-endian variant will exist.
- The IR exclusions in §4.10 (portable field names, well-formed Unicode,
  unambiguous null) are permanent: they exist so that every implementation
  accepts exactly the same set of artifacts.
- The fingerprint identifies the full codec artifact. Future columnar, delta,
  dictionary, or profiled layouts are new `plan` values under the same
  serialization scheme; v0 reserves no in-band escape values for them.
- Exact-schema compatibility with JSON fallback is the only negotiation model.
- Sub-byte packing (beyond bitmaps) is out until a future plan defines it.
- `encode()` output is a single bounded buffer; streaming needs an outer frame.

## 8. Vectors

`spec/vectors/vectors.json` — valid encode/decode pairs and invalid inputs
(both directions), body bytes only. `spec/vectors/fingerprints.json` — IR →
canonical text → fingerprint, locking §5. Every implementation runs both.
