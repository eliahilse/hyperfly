# Hyperfly plan `columnar` — v5

Status: draft. Extends `spec/wire-v0.md`; everything there (envelope, varints,
bitmaps, scalar encodings, limits, canonical serialization) applies unchanged.
The artifact is
`{"wire":1,"plan":{"layout":"columnar","version":5},"ir":…,"profile":…}` — a
different fingerprint than the row plan for the same IR, so the two never mix
on the wire. (v1 through v3 were never released; columnar@4 shipped, and a
registry that retains a v4 codec keeps decoding v4 artifacts — the plan
version is inside the fingerprint, so the two versions never mix on the
wire.)

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

### 3.1 Bit packing

Several column modes pack `k` unsigned values of a fixed width `w` bits.

- `w` is a single byte, `0 ≤ w ≤ 56`; larger MUST be rejected. The 56-bit
  ceiling matches the `uvarint` domain of wire-v0 §3.1.
- `w = 0` encodes no payload bytes at all: every value equals the frame base.
  A constant column therefore costs its base and nothing more.
- Value `i` occupies bits `[i·w, (i+1)·w)` of a little-endian bit stream: bit
  `n` is bit `n mod 8` of byte `⌊n/8⌋`, counting from the least significant.
- The payload is exactly `⌈k·w/8⌉` bytes. Bits after the last value in the
  final byte MUST be zero, and a decoder MUST reject nonzero padding — without
  that rule one value would have several encodings.
- `bitWidth(x)` is the smallest `w` with `x < 2^w`, so `bitWidth(0) = 0`.
  Several modes derive their widths with it.

`k` = participating row count.

- **literal** — zero bytes.
- **enum** — member indices bit-packed (§3.1) at width `w = bitWidth(m − 1)`
  for `m` declared members, with no width byte: the width is a pure function
  of the schema, so both sides derive it. A single-member enum packs to width
  0 and carries nothing. An index at or beyond `m` MUST be rejected (such
  indices are representable whenever `m − 1` is not `2^w − 1`). An enum wide
  enough to derive `w > 56` MUST be rejected at compile time; no body can
  carry it.
- **bytes** — `uvarint` length + bytes per value (as wire-v0).
- **string** — one **flags** byte, then the payload it selects. v5 defines
  five values, `0x00`–`0x04`; any other MUST be rejected.
  - `0x00` plain: `uvarint` length + strict UTF-8 bytes per value.
  - `0x01` dictionary: requires a dictionary for this column in the artifact's
    profile (§6); a decoder without one MUST reject the column. One width byte
    `w` (`0 ≤ w ≤ 14`; larger MUST be rejected), then `k` codes bit-packed
    (§3.1) at width `w`, then the escaped values. Code `0` is a literal escape
    and `c > 0` selects `entries[c − 1]`; a code beyond the dictionary MUST be
    rejected. Escaped values follow the packed codes in row order, one
    `uvarint` length + UTF-8 bytes per zero code. An encoder MUST emit the
    code for any value present in the dictionary and MUST NOT escape it, and
    MUST set `w = bitWidth(highest code emitted)`, so one column never has
    two encodings. Frequency-ordered dictionaries put the common values in
    the low codes, so `w` usually sits well below `bitWidth(dictionary
    size)`.
  - `0x02` deflate: `uvarint` byte length per value in row order, then a
    `uvarint` blob length and a raw-deflate (RFC 1951) stream of the
    concatenated UTF-8 bytes. The inflated size MUST equal the sum of the
    declared lengths; each slice MUST be strict UTF-8; per-value and total
    lengths obey the decoder byte limits. A decoder without an inflate
    capability MUST reject deflate columns as unsupported (and the protocol
    layer falls back to JSON) rather than guess.
  - `0x03` grammar: requires a grammar for this column in the profile (§6.3);
    a decoder without one MUST reject the column. A `uvarint` escape count
    `E` (`E ≤ k`, larger MUST be rejected); if `0 < E < k`, an escape bitmap
    of `k` bits (set bit = escaped row) whose set-bit count MUST equal `E`;
    then one **int lane** per numeric token of the grammar, in token order,
    each encoded exactly as an int column payload (mode byte and all) whose
    declared bounds are `min 0, max B^L − 1`, over the `k − E` matched rows
    in row order; then the escaped values in row order, `uvarint` length +
    UTF-8 bytes each. A matched row's string is
    reconstructed by rendering the grammar (§6.3); a lane value at or beyond
    `B^L` for its token MUST be rejected. Bitmap position `j` names the
    `j`-th row in which this column participates, in array-row order. An
    encoder MUST escape a row iff its value does not match the grammar —
    matched values ride the lanes, never the escapes.
  - `0x04` derived: requires a derivation for this column in the profile
    (§6.4); a decoder without one MUST reject the column. A `uvarint` escape
    count `E` (`E ≤ k`, larger MUST be rejected); if `0 < E < k`, an escape
    bitmap of `k` bits whose set-bit count MUST equal `E`; then the escaped
    values in row order, `uvarint` length + UTF-8 bytes each. Bitmap
    position `j` names the `j`-th row **in which this column participates**,
    in array-row order; the source is consulted at that same array row, not
    at position `j` of its own participant list — the two columns'
    participation sets may differ. A non-escaped row carries no bytes at
    all: its value is `values[i]` of the derivation, where `i` is the index
    of the source row's value in the source dictionary. For a non-escaped
    row the source MUST participate in that array row and its value MUST be
    in the source dictionary; a decoder MUST reject otherwise. An encoder
    MUST escape a row iff it does not conform (§6.4).

  Dictionary coding sits below deflate deliberately: it is fully
  deterministic while deflate output is library-dependent, so "smallest,
  ties to the lowest flags byte" (§4) also means "prefer the reproducible
  encoding". Grammar and derived modes are deterministic too; in practice
  they win on size, not on the tie rule.
- **bool** — one bitmap of `k` bits (padding rules from wire-v0 §3.5).
- **int** — one mode byte, then:
  - `0x00` raw: each value in its wire-v0 form (`uvarint(v - min)` when `min`
    is declared, else `svarint(v)`).
  - `0x01` delta: the first value in its wire-v0 form, then
    `svarint(v[i] - v[i-1])` for each subsequent value. Differences stay
    within 55 bits for domain-valid values, so the 8-byte uvarint cap holds.
  - `0x02` frame of reference: `svarint(base)`, one width byte `w`, then the
    values bit-packed (§3.1) as `v[i] - base`. `base` is the column minimum, so
    every packed value is non-negative and fits `w` bits. An encoder MUST set
    `w = bitWidth(max(v[i] − base))` — "fits" alone would give one column a
    second encoding at the same size.
  - `0x03` delta frame of reference: `svarint(v[0])`, `svarint(base)`, one
    width byte `w`, then `d[i] - base` bit-packed for `i` in `1..k-1`, where
    `d[i] = v[i] - v[i-1]` and `base` is the minimum difference. The mode
    exists only for `k ≥ 2`: with a single value there is no difference to
    frame, an encoder MUST NOT choose it and a decoder MUST reject it. An
    encoder MUST set `w = bitWidth(max(d[i] − base))`.
  - `0x04` patched frame of reference: `svarint(base)`, a low-width byte `L`
    (`0 ≤ L ≤ 55`), a high-width byte `H` (`1 ≤ H`, `L + H ≤ 56`; anything
    else MUST be rejected), an exception bitmap of `k` bits (set bit =
    exception), the low `L` bits of `v[i] - base` for **all** `k` values
    bit-packed (§3.1), then `(v[i] - base) >> L` for the exception rows only,
    in row order, bit-packed at width `H`. `base` is the column minimum,
    and the encoder MUST set a row's exception bit iff
    `(v[i] - base) >> L` is non-zero. A non-exception row's high part is
    zero by construction; an exception row's decoded high part MUST be
    non-zero — a zero high part would give the value a second encoding, and
    a decoder MUST reject it, exactly as it rejects nonzero padding.
    Reconstruction is `v[i] = base + low[i] + high[i]·2^L` in exact integer
    arithmetic — offsets legally exceed `2^53`, where binary64 rounds — and
    the result MUST be inside the wire-v0 integer domain before any
    conversion to a host numeric type, then checked against declared
    bounds.
  - Other mode bytes MUST be rejected. Declared bounds are validated per
    decoded value, after any accumulation.

  A varint spends whole bytes on values that need a fraction of one: a column
  ranging over four possible values costs eight bits each under `0x00` and two
  under `0x02`. The frame is per-column and self-describing, so it needs no
  profile — an untrained codec gets it — and it adapts to the values actually
  present rather than the bounds the schema permits. `0x04` handles the
  column that is narrow except for outliers: a single large value under
  `0x02` forces every row to the outlier's width, while under `0x04` the
  outlier alone pays — one bitmap bit per row plus its own high bits — and
  the common values keep their narrow width.
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

Encoders MUST pick the mode with the smallest encoded size; on a tie they MUST
pick the lowest mode or flags byte (`0x00` < `0x01` < … < `0x04`), so a
decode → encode round trip is byte-identical and two conforming encoders agree.
Decoders accept any valid mode — canonicality is an encoder obligation, checked
by the re-encode property, not a decode-time recomputation.

Inner choices are pinned the same way. The dictionary width is
`bitWidth(highest code emitted)`. An int `0x04` candidate considers every low
width `L` in `0 … w − 1`, where `w` is its own `0x02` width, takes the
smallest total, ties to the lowest `L`, and sets
`H = bitWidth(largest high part)`. A grammar lane is itself an int column and
obeys this section recursively. Modes that need a profile — dictionary,
grammar, derived — enter the comparison only when the profile supplies their
column, and within grammar and derived modes the escape set is forced in
both directions: an encoder MUST escape a row iff its value does not match
the grammar (`0x03`), or iff the row does not conform (`0x04`). The encoding
is then a pure function of schema, profile, and values.

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

A **profile** carries knowledge learned from a route's traffic. v5 defines
three kinds, all per string column: dictionaries (whole values that recur),
grammars (the shape of machine-generated values), and derivations (one
column functionally determined by another).

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
{"version":2,"shared":{"columns":[{"leaf":N,"dict":["…"],"grammar":[…],"derived":{…}}]},"hints":{…}}
```

- `shared` is decode-critical: without the identical bytes a peer cannot read
  the payload. It is embedded in the artifact (§6.5).
- `hints` is advisory encoder guidance that does not affect decodability. It is
  **not** part of the artifact and never changes the fingerprint, so an encoder
  can adopt new hints without a fleet-wide cutover. v5 defines no hints.
- Version 1 documents (dictionary-only) remain valid input; version 2 adds
  `grammar` and `derived`. A column entry carries at least one of the three
  keys, in any combination — the encoder's mode choice (§4) arbitrates.
- The accepted domain is closed. A version other than `1` or `2` MUST be
  rejected; a version-1 column MUST hold `leaf` and `dict` and nothing else;
  unknown keys, `null` standing in for an absent key, wrong types, and
  non-integer numeric fields MUST be rejected anywhere outside `hints`; a
  token object holds exactly one of `lit` or `num`; `columns` MUST be
  non-empty — a profile with nothing to say is expressed by having no
  profile, not by an empty one, so one codec never has two artifacts.

Constraints, all validated at compile time:

- `leaf` MUST identify a `string` leaf under §6.1 and MUST be unique across
  `columns`; `columns` MUST be sorted by ascending `leaf`.
- A dictionary holds 1–16383 entries — the historical two-`uvarint`-byte
  ceiling, kept so every code fits the 14-bit packed width of §3. Entries are
  ordered most-valuable-first so the smallest codes land on the most frequent
  values: the packed width then tracks how much of the dictionary a message
  actually touches.
- Entries MUST be unique and well-formed Unicode (§4.10 of wire-v0). Duplicate
  entries would give one value two codes and break canonicality.

### 6.3 Grammars

A grammar describes the shape of a machine-generated string —
`evt_00h2k4_9fa31c02` — as a token sequence, so the wire carries the few bits
that vary instead of the many bytes that repeat.

```
"grammar":[{"lit":"evt_"},{"num":{"base":36,"len":6,"case":"lower"}},
           {"lit":"_"},{"num":{"base":16,"len":8,"case":"lower"}}]
```

- A token is either `{"lit": s}` — a verbatim run, non-empty, well-formed
  (wire-v0 §4.10) — or `{"num": {"base": B, "len": L, "case": C}}` — an
  unsigned integer rendered in base `B ∈ {10, 16, 36}` as exactly `L` digits,
  zero-padded. The digit alphabet is the first `B` symbols of
  `0123456789abcdefghijklmnopqrstuvwxyz` when `C` is `"lower"` and of the
  uppercase counterpart when `"upper"`; a digit's numeric value is its
  position in that alphabet, matched as exact ASCII — no Unicode digit
  recognition, no case folding. For base 10, `C` MUST be `"lower"`.
- 1–8 tokens, at least one `num`, and no two adjacent `lit` tokens — two
  splittings of the same text must not both be canonical.
- `L` MUST be an integer with `1 ≤ L`, capped so every lane value fits the
  wire-v0 integer domain: `L ≤ 15` for base 10, `L ≤ 13` for base 16,
  `L ≤ 10` for base 36.

A value **matches** the grammar iff consuming each token in order consumes the
whole string exactly: each literal appears verbatim, and each numeric token's
`L` characters all belong to its base and case. A digit of the wrong case is a
non-match, not an error. Fixed widths make the scan unambiguous with no
backtracking, and zero-padding makes parse-then-render the identity, so
matching is a pure function of the value — both sides always agree, which is
what makes the encoder's MUST-use rule (§3) enforceable.

Matched values travel as one integer per numeric token in per-token lanes
(§3 string mode `0x03`). Sequential ids meet the delta and frame-of-reference
machinery there and often cost close to nothing; random hex costs its true
bits — four bits per digit instead of eight.

### 6.4 Derivations

Traffic often repeats a functional dependency the schema cannot express:
every row with one `actorId` also has the same `actorEmail`. A derivation
records that mapping once, in the profile, and the dependent column then
ships nothing at all for rows that obey it.

```
"derived":{"source":N,"values":["…",…]}
```

- `source` MUST be the ordinal of another string leaf of the **same eligible
  array**, strictly less than this column's ordinal — columns decode in
  order, so the source is already decoded — and the profile MUST hold a
  dictionary for the source column. Chains through a derived source are
  legal; the ordering rule makes cycles impossible.
- `values` maps by position: a row whose source value is `dict[i]` derives
  `values[i]`. Its length MUST equal the source dictionary's, and every
  entry MUST be well-formed (wire-v0 §4.10). `values` entries need not be
  unique — two actors may share an email domain-wide.

A row **conforms** iff the source participates in that row, the source value
is in the source dictionary, and `values[i]` equals the actual value. The
encoder MUST NOT escape a conforming row; the decoder MUST reject a
non-escaped row whose source is absent or out of dictionary (§3 string mode
`0x04`). The mapping is by source *value*, not by the source column's wire
mode — the source may itself arrive plain, deflated, dictionary-coded, via a
grammar, or derived.

### 6.5 Artifact embedding

The canonical artifact gains one key, after `ir`, present only when a profile
exists:

```
{"wire":1,"plan":{"layout":"columnar","version":5},"ir":<node>,"profile":<shared>}
```

serialized with the §5 rules and these fixed key orders, absent keys omitted:

```
shared    {"columns":[<column>,…]}
column    {"leaf":N,"dict":[<string>,…],"grammar":[<token>,…],"derived":<derived>}
token     {"lit":<string>} | {"num":{"base":B,"len":L,"case":<string>}}
derived   {"source":N,"values":[<string>,…]}
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

### 6.6 Rotation

Retraining produces different dictionary bytes, therefore a different
fingerprint, therefore a hard cutover: during a rolling deploy every request
between mismatched peers falls back to JSON. A decoder SHOULD keep a registry
of codecs keyed by fingerprint and select per request, so old and new profiles
are readable simultaneously and rotation is not a cliff.

### 6.7 Training is non-normative

How a profile is produced is out of scope. Any document satisfying §6.2 is
valid, and the artifact pins the exact bytes, so implementations need not agree
on a training algorithm — only on canonicalization and the wire. Reference
trainers are conveniences, not part of the contract.

If an implementation does order values (in a trainer, or anywhere else), it
MUST compare their UTF-8 byte sequences. JavaScript's default string comparison
is UTF-16 code-unit order, which disagrees with UTF-8 byte order above the BMP:
`U+FFFD` (`EF BF BD`) sorts before `U+10000` (`F0 90 80 80`) by bytes and by
code point, but after it in JavaScript.

### 6.8 Scope and cautions

Dictionaries apply only to **string columns of eligible arrays**. A string
outside an array, or inside an array that falls back to the row encoding, gets
nothing from a profile in v5.

Two operational cautions:

- A dictionary contains verbatim values from production traffic. It is a
  build artifact that gets logged, committed, and shared, so a dictionary
  trained on one tenant's data MUST NOT be used to serve another's.
- Whether a value is dictionary-coded is observable in the response length, so
  a profiled route leaks a coarse membership signal about its own dictionary.
  This is a persistent, cross-request variant of the compression-oracle
  problem, and it is why dictionary coding is opt-in per route.
