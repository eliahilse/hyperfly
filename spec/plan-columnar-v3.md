# Hyperfly plan `columnar` — v3

Status: draft. Extends `spec/wire-v0.md`; everything there (envelope, varints,
bitmaps, scalar encodings, limits, canonical serialization) applies unchanged.
The artifact is
`{"wire":1,"plan":{"layout":"columnar","version":3},"ir":…,"profile":…}` — a
different fingerprint than the row plan for the same IR, so the two never mix
on the wire. (v1 and v2 were never released; no artifact for either exists in
the wild.)

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
- **string** — one **flags** byte, then the payload it selects. Bit 0 selects
  dictionary coding, bit 1 selects deflate. Bits 2–7 are reserved and MUST be
  zero. v3 defines three values; `0x03` (dictionary + deflate) is reserved and
  MUST be rejected until a later version defines it.
  - `0x00` plain: `uvarint` length + strict UTF-8 bytes per value.
  - `0x01` dictionary: requires a dictionary for this column in the artifact's
    profile (§6); a decoder without one MUST reject the column. Per value a
    `uvarint` code: `0` is a literal escape followed by `uvarint` length +
    UTF-8 bytes, and `n > 0` selects `entries[n − 1]`. A code beyond the
    dictionary MUST be rejected. An encoder MUST emit the
    code for any value present in the dictionary and MUST NOT escape it, so one
    value never has two encodings.
  - `0x02` deflate: `uvarint` byte length per value in row order, then a
    `uvarint` blob length and a raw-deflate (RFC 1951) stream of the
    concatenated UTF-8 bytes. The inflated size MUST equal the sum of the
    declared lengths; each slice MUST be strict UTF-8; per-value and total
    lengths obey the decoder byte limits. A decoder without an inflate
    capability MUST reject deflate columns as unsupported (and the protocol
    layer falls back to JSON) rather than guess.

  Bit 0 is the low bit deliberately: dictionary coding is fully deterministic
  while deflate output is library-dependent, so "smallest, ties to the lowest
  flags byte" (§4) also means "prefer the reproducible encoding".
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
    `m = sign(v) · floor(|v| · 10^d + 0.5)`, where `|v| · 10^d` and the
    subsequent `+ 0.5` are two separately rounded IEEE 754 binary64
    operations — implementations MUST NOT contract them into a fused
    multiply-add, which would round once and can differ in the last place.
    Encoders may choose these modes
    only when `d` is the smallest scale for which every value satisfies
    `m / 10^d == v` exactly with `m` in the integer domain;
    decoding computes `Number(m) / 10^d`, which reproduces the encoder's
    doubles exactly because both sides perform one correctly-rounded IEEE 754
    division of the same integers. Mantissas outside the v0 integer domain
    MUST be rejected.

When `k = 0`, int, float, and string columns still emit their mode/flags byte,
which MUST be `0x00`; other columns emit nothing.

## 4. Encoder mode choice

Encoders MUST pick the mode with the smaller encoded size; on a tie they MUST
pick the lowest mode byte (`0x00` < `0x01` < `0x02` < `0x03`), so a
decode → encode round trip is byte-identical and two conforming encoders agree.
Decoders accept any valid mode — canonicality is an encoder obligation, checked
by the re-encode property, not a decode-time recomputation.

Two capabilities scope that obligation:

- **Packing.** Deflate output is not canonical across libraries, so
  byte-identical re-encode holds within an implementation+version; any
  spec-valid stream decodes everywhere. An implementation without a deflate
  capability emits string columns in plain mode (`0x00`) and rejects packed
  input as unsupported — its output is canonical *for that capability*, and a
  peer that packs still decodes it. The fingerprint identifies the schema and
  plan, not the packing capability; peers with different packing capabilities
  interoperate because every decoder accepts both string modes.
- **Inflater strictness.** A decoder's inflater MUST require the declared blob
  to be exactly one complete DEFLATE stream: reject truncation, output longer
  than the declared total, and any trailing bytes after the final block.

## 5. Rationale (non-normative)

Column layout groups same-typed bytes, which helps both this plan's own
transforms and any generic compressor stacked on top. Delta turns monotonic
series (timestamps, counters) into small varints. XOR captures the high-bit
locality of slowly-moving float series while staying byte-aligned — the
bit-granular Gorilla-style windows belong to a future plan, alongside
profile-trained dictionaries and entropy coding.

## 6. Profiles

A **profile** carries knowledge learned from a route's traffic. v3 defines one
kind: per-column string dictionaries.

### 6.1 Column ordinals

A profile names columns by **ordinal**, never by a textual path. Field names may
legally contain `.`, `[`, `]`, and `$`, so a dotted path is ambiguous:
`struct{"a.b": struct{"c": string}}` and `struct{"a": struct{"b.c": string}}`
would produce the same key while binding to different leaves — a mismatch the
fingerprint cannot catch, because both peers compute the same artifact text.

Ordinals come from one total enumeration of the IR:

1. Walk the IR depth-first in declared order: struct fields in declared order,
   `nullable` into its inner node, ineligible arrays into their element.
2. On reaching an **eligible** array (§1), emit its flattened leaves in
   `flattenLeaves` order as consecutive ordinals, then do not descend further
   into that array — an eligible element contains no nested arrays by
   definition.

The result numbers every columnar leaf in the whole schema `0 … N−1`.

### 6.2 Profile document

```
{"version":1,"shared":{"columns":[{"leaf":N,"dict":["…","…"]}]},"hints":{…}}
```

- `shared` is decode-critical: without the identical bytes a peer cannot read
  the payload. It is embedded in the artifact (§6.3).
- `hints` is advisory encoder guidance that does not affect decodability. It is
  **not** part of the artifact and never changes the fingerprint, so an encoder
  can adopt new hints without a fleet-wide cutover. v3 defines no hints.

Constraints, all validated at compile time:

- `leaf` MUST identify a `string` leaf under §6.1 and MUST be unique across
  `columns`; `columns` MUST be sorted by ascending `leaf`.
- A dictionary holds 1–16383 entries, the ceiling at which a code still fits two
  `uvarint` bytes. Entries are ordered most-valuable-first so the shortest codes
  land on the most frequent values: code length then depends only on position,
  which keeps an encoder's cost model linear rather than self-referential.
- Entries MUST be unique and well-formed Unicode (§4.10 of wire-v0). Duplicate
  entries would give one value two codes and break canonicality.

### 6.3 Artifact embedding

The canonical artifact gains one key, after `ir`, present only when a profile
exists:

```
{"wire":1,"plan":{"layout":"columnar","version":3},"ir":<node>,"profile":<shared>}
```

serialized with the §5 rules and these fixed key orders:

```
shared    {"columns":[<column>,…]}
column    {"leaf":N,"dict":[<string>,…]}
```

The **whole dictionary content** is embedded, not a hash or a name. A hash would
still require a canonical serializer to compute, and a name (`"prod-2026-08"`)
is expressly forbidden: two peers could then agree on a fingerprint while
holding different dictionary bytes, which is exactly the failure the
fingerprint exists to prevent.

Artifact text is never trusted from a peer. An implementation MUST derive the
artifact from its own parsed IR and profile, and MUST NOT accept artifact text
and hash it — a decoder could otherwise match a fingerprint for a plan or
profile it cannot actually read.

### 6.4 Rotation

Retraining produces different dictionary bytes, therefore a different
fingerprint, therefore a hard cutover: during a rolling deploy every request
between mismatched peers falls back to JSON. A decoder SHOULD keep a registry
of codecs keyed by fingerprint and select per request, so old and new profiles
are readable simultaneously and rotation is not a cliff.

### 6.5 Training is non-normative

How a profile is produced is out of scope. Any document satisfying §6.2 is
valid, and the artifact pins the exact bytes, so implementations need not agree
on a training algorithm — only on canonicalization and the wire. Reference
trainers are conveniences, not part of the contract.

If an implementation does order values (in a trainer, or anywhere else), it
MUST compare their UTF-8 byte sequences. JavaScript's default string comparison
is UTF-16 code-unit order, which disagrees with UTF-8 byte order above the BMP:
`U+FFFD` (`EF BF BD`) sorts before `U+10000` (`F0 90 80 80`) by bytes and by
code point, but after it in JavaScript.

### 6.6 Scope and cautions

Dictionaries apply only to **string columns of eligible arrays**. A string
outside an array, or inside an array that falls back to the row encoding, gets
nothing from a profile in v3.

Two operational cautions:

- A dictionary contains verbatim values from production traffic. It is a
  build artifact that gets logged, committed, and shared, so a dictionary
  trained on one tenant's data MUST NOT be used to serve another's.
- Whether a value is dictionary-coded is observable in the response length, so
  a profiled route leaks a coarse membership signal about its own dictionary.
  This is a persistent, cross-request variant of the compression-oracle
  problem, and it is why dictionary coding is opt-in per route.
