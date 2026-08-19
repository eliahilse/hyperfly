# Hyperfly plan `columnar` — v2

Status: draft. Extends `spec/wire-v0.md`; everything there (envelope, varints,
bitmaps, scalar encodings, limits, canonical serialization) applies unchanged.
The artifact is `{"wire":1,"plan":{"layout":"columnar","version":2},"ir":…}` —
a different fingerprint than the row plan for the same IR, so the two never
mix on the wire. (v1 lacked string column modes and was never released; no v1
artifact exists in the wild.)

## 1. Scope

Under this plan, every **eligible** `array` node is encoded column-wise.
Eligible: the element is a `struct` whose fields are primitives (`bool`,
`int`, `float64`, `string`, `bytes`, `enum`, `literal`) or required,
non-nullable structs of the same shape, recursively, with at least one leaf.
Nested structs flatten into leaf columns, depth-first in declared order, so a
leaf's participation is exactly its row's; leaf-level `optional`/`nullable`
flags keep their bitmaps. Anything else — arrays or nullable/optional structs
inside the element — sends the whole array down the row encoding from
wire-v0 §4.8/§4.10. Eligibility is a pure function of the IR, so both sides
always agree.

## 2. Layout of an eligible array

1. `uvarint` row count `n` (omitted for fixed-length arrays).
2. For each field, in declared order:
   a. If `optional`: presence bitmap, `n` bits.
   b. If `nullable`: null bitmap, `n` bits — one bit per row regardless of
      presence; the bit for an absent row MUST be zero.
   c. The column payload over **participating** rows (present and not
      bitmap-null), in row order.

## 3. Column payloads

`k` = participating row count.

- **literal** — zero bytes.
- **enum** — `uvarint` index per value.
- **bytes** — `uvarint` length + bytes per value (as wire-v0).
- **string** — one mode byte, then:
  - `0x00` plain: `uvarint` length + strict UTF-8 bytes per value.
  - `0x01` packed: `uvarint` byte length per value in row order, then a
    `uvarint` blob length and a raw-deflate (RFC 1951) stream of the
    concatenated UTF-8 bytes. The inflated size MUST equal the sum of the
    declared lengths; each slice MUST be strict UTF-8; per-value and total
    lengths obey the decoder byte limits. A decoder without an inflate
    capability MUST reject packed columns as unsupported (and the protocol
    layer falls back to JSON) rather than guess.
- **bool** — one bitmap of `k` bits (padding rules from wire-v0 §3.5).
- **int** — one mode byte, then:
  - `0x00` raw: each value in its wire-v0 form (`uvarint(v - min)` when `min`
    is declared, else `svarint(v)`).
  - `0x01` delta: the first value in its wire-v0 form, then
    `svarint(v[i] - v[i-1])` for each subsequent value. Differences stay
    within 55 bits for domain-valid values, so the 8-byte uvarint cap holds.
  - Other mode bytes MUST be rejected. Declared bounds are validated per
    decoded value, after delta accumulation.
- **float64** — one mode byte, then:
  - `0x00` raw: each value as 8 bytes LE (wire-v0 §4.5 rules per value).
  - `0x01` xor: first value as 8 bytes LE, then for each subsequent value a
    significance length byte `s` (0–8) followed by the `s` low-order bytes of
    `bits(v[i]) XOR bits(v[i-1])`, little-endian. `s` MUST be minimal: for
    `s > 0` the highest emitted byte MUST be non-zero; `s = 0` means the
    value repeats exactly. `s > 8` MUST be rejected. Every reconstructed
    value MUST be finite and MUST NOT be the negative-zero bit pattern.
  - `0x02` scaled-delta / `0x03` scaled-raw: a scale byte `d` (0–8, larger
    MUST be rejected), then mantissas `m[i] = v[i] · 10^d` — `svarint(m[0])`
    followed by `svarint(m[i] - m[i-1])` for `0x02`, or `svarint(m[i])` per
    value for `0x03`. The mantissa is pinned to pure IEEE 754 operations so
    every language derives the same bytes:
    `m = sign(v) · floor(|v| · 10^d + 0.5)`. Encoders may choose these modes
    only when `d` is the smallest scale for which every value satisfies
    `m / 10^d == v` exactly with `m` in the integer domain;
    decoding computes `Number(m) / 10^d`, which reproduces the encoder's
    doubles exactly because both sides perform one correctly-rounded IEEE 754
    division of the same integers. Mantissas outside the v0 integer domain
    MUST be rejected.

When `k = 0`, int, float, and string columns still emit their mode byte
(`0x00`); other columns emit nothing.

## 4. Encoder mode choice

Encoders MUST pick the mode with the smaller encoded size, choosing `0x00` on
ties, so a decode → encode round trip is byte-identical. Decoders accept any
valid mode — canonicality is an encoder obligation, checked by the re-encode
property, not a decode-time recomputation. For packed string columns the
obligation is scoped to one implementation: deflate output is not canonical
across libraries, so byte-identical re-encode holds within an
implementation+version, while any spec-valid stream decodes everywhere.

## 5. Rationale (non-normative)

Column layout groups same-typed bytes, which helps both this plan's own
transforms and any generic compressor stacked on top. Delta turns monotonic
series (timestamps, counters) into small varints. XOR captures the high-bit
locality of slowly-moving float series while staying byte-aligned — the
bit-granular Gorilla-style windows belong to a future plan, alongside
profile-trained dictionaries and entropy coding.
