# Hyperfly wire format — v0

Status: stable. The contract is frozen for hyperfly 1.x; see
[Stability](#stability). This document and the vectors under `spec/vectors/`
are the authorities on the format. The TypeScript, Python and Rust
implementations each reproduce the vectors byte-for-byte; any other
implementation MUST do the same. Where an implementation and this document
disagree, the document wins.

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

An integer-valued IR field accepts any JSON number whose value is an integer
in `[-(2^53 - 1), 2^53 - 1]` (§3.3), and zero is the integer 0 whatever its
sign; fractional values and values beyond that range are invalid IR.

For an `int` node or an integer `literal`, a value MUST be accepted as an
integer regardless of its host representation when it is a number whose
value is an integer in that domain: `1.0` is 1 and `-0.0` is 0. Booleans are
not numbers. Fractional, non-finite and out-of-domain values MUST be rejected
on encode with `type`; declared bounds are checked as in §4.4.

IR nodes MUST be objects whose `kind` names one of the kinds below, with all
required members shown below; fields MUST be objects with `name` and `type`.
Node-valued members MUST themselves be valid IR nodes. `members` and `fields`
MUST be arrays. Optional members, when present, MUST have the declared type;
`null` is not an absent member.

### 4.1 `bool`

One byte: `0x00` false, `0x01` true. Decoders MUST reject other values.

### 4.2 `literal`

Zero bytes. The value is part of the artifact. v0 literal values are strings,
booleans, `null`, or JSON-safe integers (non-integer numeric literals are not
representable in v0).

An integer literal matches any numeric value equal to that integer under the
§4 rule, including an integral floating-point value. A mismatch MUST be
rejected on encode with `type`.

### 4.3 `enum { members }`

ULEB128 index into `members`, in declared order. Index MUST be
`< members.length`. `members` MUST contain at least one member, and each
member MUST be a unique, non-empty string. Declared order is canonical;
reordering members is a new artifact.

### 4.4 `int { min?, max? }`

- If `min` is declared: `uvarint(value - min)` using exact integer arithmetic.
- Otherwise: `svarint(value)`.
- Declared bounds are validated on encode AND decode; out-of-bounds MUST be
  rejected on both sides with `range`. On encode, the §4 integer-domain
  check precedes the bound checks, including for integral floating-point
  values.
- If both bounds are declared, `min` MUST NOT exceed `max`.

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

A declared `length` MUST be a non-negative integer in the domain of §3.3.

### 4.9 `nullable { inner }`

One byte: `0x00` null (nothing follows), `0x01` value follows. Other values
rejected. `nullable(nullable(T))` is invalid IR. Inside a struct, prefer the
field flag (§4.10), which uses the bitmap instead.

### 4.10 `struct { fields }`

Field order is declared order and is canonical.
Field names MUST be non-empty strings and MUST be unique within a struct.

**Portable field names.** A field name MUST NOT be `__proto__`, and MUST NOT be
a decimal array index (`0`, or a digit string with no leading zero whose value
is below 2^32 − 1). Some host languages reorder integer-index object keys and
trap `__proto__` assignment, so such names cannot round-trip or fingerprint
identically everywhere. Field names, enum members, and string literals MUST
also be well-formed Unicode: a sequence of Unicode scalar values. Lone
surrogates MUST be rejected at IR validation; every other scalar value,
including NUL, U+FFFE, U+FFFF and unassigned code points, MUST be accepted
subject to the other constraints on that string.

**Closed objects.** IR nodes and fields MUST NOT carry keys this
specification does not define for their kind, and profile objects MUST NOT
carry keys the columnar plan's profile document (plan-columnar-v5 §6.2) does
not define; such IR or profile is invalid.

**Artifact nesting.** The canonical artifact text (§5, plan-columnar-v5
§6.5) MUST NOT nest JSON containers deeper than 512. The artifact object is
depth 1; every object or array value is one deeper than its container.
This depth is a function of the IR and profile alone, independent of their
input spelling. An IR or profile whose artifact would exceed this bound is
invalid IR and MUST be rejected with `ir`. Acceptance within the bound
MUST NOT depend on a host-language recursion limit, and an implementation
MUST reject IR or a profile past the bound without unbounded recursion.
Implementations MUST document any host stack sizing they require. This bound
is independent of `maxDepth` (§6).

**Unambiguous null.** `nullable(literal null)`, and a field carrying the
`nullable` flag over a `literal null` type, are both invalid: they give one
value two wire encodings. A field's `nullable` flag MUST NOT be true when its
type is a `nullable` node. Each field has `optional` and
`nullable` flags. When present, each flag MUST be a JSON boolean; any other
value is invalid IR. Layout:

1. **Presence bitmap** over the optional fields, in field order. Bit set =
   present.
2. **Null bitmap** over the nullable fields, in field order — one bit per
   nullable field regardless of presence. Bit set = null. For an absent
   field the bit MUST be zero.
3. Field values, in field order, for fields that are present and not null.

A decoder MUST read the presence bitmap and then the null bitmap, validating
each bitmap's padding, before processing fields in declared order. It MUST
check a field's absent/null consistency when that field is reached, reporting
a null bit for an absent field as `bitmap`; it MUST NOT check this before
decoding earlier fields' values.

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

## 6. Limits

Implementations MUST enforce configurable limits with these v0 defaults:

- `maxDepth` 64: a node's depth is the number of struct, array and nullable
  nodes enclosing it, and decoding a node deeper than `maxDepth` is rejected
  with `depth`,
- `maxItems` 2^24 per array, applied to a declared length as to a count,
- `maxByteLength` 2^28 per string/bytes value and per declared inflated
  total of a deflate-packed string column (plan-columnar-v5 §3), checked
  against the length prefix before any payload byte is read; for a decoder
  with inflate also per blob of such a column, checked against the blob
  length before any blob byte is read (a decoder without inflate rejects the
  column as `unsupported` without reading the blob length, below),
- `maxAmplification` 32: an array count above
  `maxAmplification × (remaining bytes + 1)` is rejected, where remaining
  bytes are the body bytes after the count or, for a fixed-length array,
  after the point the array is entered. Compressed layouts can legitimately
  describe many rows with almost no bytes, so input length alone cannot bound
  a count; this caps the work one hostile byte can demand instead. A
  row-encoded array (in either plan, including an array the columnar plan
  leaves to the row encoding) whose element is not zero-bit is held to the
  stricter **one-bit floor** in its place: a count beyond the remaining bits
  is unpayable and MUST be rejected. An element type is zero-bit when it is a
  `literal`; a struct whose fields are all required, non-nullable and
  zero-bit; or a fixed-length array whose length is 0 or whose element is
  zero-bit. Arrays of zero-bit elements fall under the amplification bound.
- `maxTotalItems` 2^24 per message, and the **item budget**: the sum of the
  element counts of every array in one body (fixed and variable, row and
  columnar, at every depth) MUST NOT exceed
  `min(maxTotalItems, maxAmplification × (body length + 1))`, where body
  length is the number of bytes after the envelope header (§2). A decoder
  operates on the complete body (§2 frames one bounded buffer), so it
  computes this cap once from the full body length, not from the bytes
  received so far. Each count is charged once, on entry to its array; a
  columnar eligible array is charged its row count `n` only, never per leaf
  or per participating row. Per-array checks bound one count; the budget
  bounds their product, which nesting otherwise multiplies.
- `maxTotalBytes` 2^26 per message and `maxByteAmplification` 64, and the
  **byte budget**: the sum of the decoded byte lengths of every string and
  bytes value in one body (UTF-8 bytes for a string; at every depth, in both
  plans) MUST NOT exceed
  `min(maxTotalBytes, maxByteAmplification × (body length + 1))`, computed
  once from the full body length as for the item budget. The sum includes
  values a decoder reconstructs rather than reads: literals, enum members,
  and the dictionary, grammar and derived values of plan-columnar-v5. Those,
  and deflate-packed string columns, are why the byte budget exists beside
  the item budget: a row can cost one bit or nothing on the wire and still
  decode to a long string, and a packed column inflates about a thousand
  bytes per body byte. `maxByteLength` bounds one value; the byte budget
  bounds their sum.

For each array, before reading any element or allocating anything
proportional to its count, a decoder applies `maxDepth` on entering the
array node; reads the count, for a variable-length array; then applies
`maxItems`, the one-bit floor or the amplification bound (whichever applies),
and charges the budget, in that order. A failure of any check but depth is
reported as `limit`. The fixed order makes every implementation report the
same failure for the same input.

A decoder charges each string or bytes value against the byte budget as soon
as its length is known, before reading or allocating its bytes, and reports
an exceeded budget as `limit`:

- a length-prefixed value (including an escaped value in a dictionary,
  grammar or derived column), after `maxByteLength` is applied to its prefix
  and before its bytes are read;
- a deflate-packed string column (plan-columnar-v5 §3), once, with its
  declared inflated total, after `maxByteLength` is applied to each declared
  length and to the total, and before the blob length is read; a decoder
  without an inflate capability charges it the same way and only then
  rejects the column as `unsupported`; otherwise it reads the blob length
  and MUST reject a length above `maxByteLength` with `limit` before reading
  any blob byte. Its values are not charged again;
- a dictionary, grammar or derived value, when it is resolved, after its own
  checks (code range, source lookup) and after `maxByteLength` is applied to
  its length, and before it is built (a grammar value's length follows from
  its tokens, so it is known before rendering);
- a literal or enum member, each time it is decoded; a columnar literal leaf
  is charged for all of its participating rows at once. Literals and enum
  members are schema constants: `maxByteLength` does not apply to them, the
  byte budget does.

Within a column, a decoder first reads the column's structure (mode, escape
count and bitmap, packed codes, indexes or grammar lanes, with their padding
checks), then resolves values one at a time in participating-row order,
completing each value's checks and charge before examining the next, so the
first failing value determines the error.

An encoder applies `maxDepth`, `maxItems` and `maxByteLength` as a decoder
does. It applies the amplification bound to every array with, in place of
remaining bytes, the number of bytes the array's own encoding occupies after
its count (for a fixed-length array, all of its bytes), and the item and byte
budgets with the final body length, counting values exactly as a decoder
charges them. It applies the same one-bit floor as a decoder, to the same
arrays, measured by those same bytes. An encoder that would violate any of
these MUST refuse the value, with `depth` for `maxDepth` and `limit`
otherwise. An encoder may therefore refuse a value whose body a decoder
would accept (the decoder's remaining bytes include later siblings), never
the reverse.

Limits are local to each peer and are not negotiated. A peer holding lower
limits rejects a body its sender accepted; over HTTP, an encoder's refusal
is covered by the JSON fallback (negotiation-v1 §2). A route that
legitimately ships denser payloads (long runs of width-zero columns, arrays
of literals, strings that are mostly dictionary hits) raises the limits on
both peers: `maxAmplification` for items, `maxByteAmplification` for bytes.

Truncation anywhere is an error. Errors are errors — never best-effort
partial values.

## 7. Frozen decisions (deliberately unimplemented)

- Little-endian everywhere; no big-endian variant will exist.
- The IR exclusions in §4.10 (portable field names, well-formed Unicode,
  closed objects, artifact nesting, unambiguous null) are permanent: they
  exist so that every implementation accepts exactly the same set of
  artifacts.
- The fingerprint identifies the full codec artifact. Future columnar, delta,
  dictionary, or profiled layouts are new `plan` values under the same
  serialization scheme; v0 reserves no in-band escape values for them.
- Exact-schema compatibility with JSON fallback is the only negotiation model.
- Sub-byte packing (beyond bitmaps) is out until a future plan defines it.
- `encode()` output is a single bounded buffer; streaming needs an outer frame.

## 8. Vectors

The vector files are listed under [Vectors](#vectors) in Stability.

Hex is body bytes only. `decodeOnly` rows are decoded without requiring an
encode round trip; in `limits.json`, the encoder MUST refuse their values
(§6). `packedDecode` rows run on decoders alone because deflate output differs
between libraries.

## 9. Errors

Codec operations (IR/profile validation and compile, encode, decode) and
artifact loading (negotiation-v1 §3) MUST report the following stable
lowercase codes on the implementation's error type. References to the plan
below mean plan-columnar-v5.

- `varint` (decode): non-minimal ULEB128 or more than eight bytes (§3.1).
- `range` (encode, decode): declared numeric bounds are exceeded, or a decoded
  number, index, code or derived source is outside its domain
  (§3.3, §4.3–§4.4, plan §3).
- `type` (encode): a value mismatches its type (including safe integers),
  literal, enum, fixed length or nullability (§4).
- `required` (encode): a required field is absent (§4.10).
- `utf8` (encode, decode): a lone surrogate on encode or invalid UTF-8 on
  decode (§4.6, plan §3).
- `float` (encode, decode): a non-finite float; on decode, negative zero or
  non-minimal XOR encoding (§4.5, plan §3).
- `marker` (decode): an invalid boolean, nullable marker, column mode or
  mode parameter (§4.1, §4.9, plan §3).
- `bitmap` (decode): nonzero bitmap or packed padding, an absent field marked
  null, inconsistent escape bits or a zero patched-frame exception high part
  (§3.5, §4.10, plan §3).
- `trailing` (decode): bytes remain after a complete body (§2).
- `truncated` (decode): input ends before a value is complete (§3–§4, §6,
  plan §3).
- `depth` (encode, decode): traversal exceeds `maxDepth` (§6).
- `limit` (encode, decode): an item, byte, amplification or remaining-input
  bound is exceeded (§6).
- `header` (decode): a short envelope, bad magic or wrong wire major (§2).
- `fingerprint` (decode, artifact loading): the envelope fingerprint differs
  from the codec's fingerprint (§2), loaded artifact content does not hash
  to the fingerprint it was fetched under, or a fingerprint supplied for
  artifact loading is not 32 hex characters (negotiation-v1 §3).
- `ir` (compile): invalid IR or profile (§4, plan §6.1–§6.5), or an artifact
  naming an unimplemented wire, plan layout or plan version (Stability).
- `packed` (decode): invalid DEFLATE, trailing bytes in its blob or wrong
  inflated length (plan §3–§4).
- `unsupported` (decode; compile in host-language schema adapters): missing
  inflate capability or a required profile entry (plan §3), or a host schema
  construct with no IR equivalent.
- `artifact` (artifact loading): a discovery response or loaded artifact
  cannot be read: a non-2xx status other than the `404` miss of
  negotiation-v1 §3, an unreadable, oversized or non-UTF-8 body, or text that
  is not well-formed JSON. Parsed content that is not a valid artifact, IR or
  profile is `ir`.

The code is the contract; messages are not. Wherever a vector pins a code,
every implementation MUST report that code. §6 fixes the order of limit
checks so the same input yields the same code. Implementations may define
further codes for failures outside this document (option validation,
host-adapter validation failures, JSON parsing outside artifact loading); those MUST NOT replace a code
above for a failure this document defines.

## Stability

### Frozen

Every hyperfly 1.x release preserves:

- The magic `0x68 0x66`, wire major `0x01` and envelope (§2).
- The primitives (§3), row@1 node encodings (§4), and columnar@5 layout and
  column payloads (plan-columnar-v5).
- Canonical serialization and fingerprinting (§5, plan-columnar-v5 §6.5):
  an IR, plan and profile yield the same artifact text and fingerprint in
  every 1.x release.
- The set of valid IR and profile documents, as this document (§4,
  plan-columnar-v5 §6.2) and the vectors define it. It is never narrowed,
  and widens only by the additions below.
- For every existing artifact, the set of bodies a decoder accepts at the
  same limits and the decoded value of each, as this document and the
  vectors define them. A 1.x release MUST NOT change that set in either
  direction.
- The error codes of §9 for the failures they cover.
- The limit names and defaults of §6. A decoder configured with the defaults
  MUST accept every valid body within them (a deflate-packed column also
  needs the inflate capability, plan-columnar-v5 §3); the check order of §6
  is fixed.
- Negotiation-v1 as a whole: `application/vnd.hyperfly`; `Hyperfly-Accept`,
  `Hyperfly-Codec` and `Hyperfly-Offer`; the
  `/.well-known/hyperfly/<fingerprint>` path; the `Accept` and
  `Hyperfly-Accept` parsing rules; fallback conditions; `Vary`; and the
  status rules of negotiation-v1 §4 in their order.

An implementation that accepts or rejects differently from the sets above
has a defect. Fixing it to conform is not a breaking change, and the fix
adds a vector row that pins the corrected behaviour.

### Additions

1.x may add only what an existing peer cannot misread:

- New plan layouts or versions, IR node kinds or fields, and profile column
  kinds. Each produces new artifact text and a new fingerprint;
  a peer that does not hold it falls back to JSON as for any unknown
  fingerprint (negotiation-v1 §2). No existing artifact's bytes or fingerprint
  change.
- A new profile document version, provided any content it gives a new
  meaning is distinguishable in the serialized profile or the plan version,
  so a peer that does not implement it refuses it with `ir`. The profile
  `version` itself is not part of the artifact text.
- New `hints` (plan-columnar-v5 §6.2), which are outside the artifact.
- New optional HTTP headers, ignored by peers that do not know them.
- A new media type, for a negotiation change that a 1.x peer could otherwise
  misread under `application/vnd.hyperfly`.
- New error codes, only for failures of something added.
- New limits, only with defaults that reject nothing a 1.x decoder at the
  defaults accepts.

Implementations need not support an addition to remain conforming. They
MUST NOT change behaviour for anything frozen under Frozen.

### A future wire version

A wire major other than `0x01` is a different envelope: a 1.x decoder MUST
reject it with `header` before reading any body byte. A new major is selected
like every codec: its artifact text names its wire value, giving it its own
fingerprint. A client advertises it in `Hyperfly-Accept`, most preferred
first, beside its wire-1 fingerprints; a server that holds it may answer with
it, and every peer that does not hold it gets the JSON fallback. No new
negotiation mechanism is needed. A change to negotiation itself that a 1.x
peer could misread uses new header names or a new media type, never a new
meaning for an existing one.

A 1.x peer loading artifact text (negotiation-v1 §3) MUST refuse a wire, plan
layout or plan version it does not implement with `ir` and continue in JSON.
It MUST NOT compile it as a different version.

### Vectors

The JSON files under `spec/vectors/` are the 1.x compatibility suite:

- `accept.json` — `Hyperfly-Accept` parsing (negotiation-v1 §6).
- `bytes.json` — byte budgets at and past their bounds (§6).
- `columnar.json` — payloads, profiles and artifacts (plan-columnar-v5).
- `fingerprints.json` — IR → canonical text → fingerprint (§5,
  plan-columnar-v5 §6.5).
- `http.json` — JSON body representation, response decoding and request bounds
  (negotiation-v1 §§2, 4).
- `ir.json` — invalid IR and valid near misses (§4, plan-columnar-v5 §6.2).
- `limits.json` — limits at and past their bounds, encode and decode (§6).
- `vectors.json` — row encode/decode pairs and invalid inputs (§3–§4).

Every 1.x implementation MUST pass every applicable row: each row that pins
Frozen behaviour, and each row for an Addition the implementation
implements. `accept.json` and `http.json` bind only implementations that
provide HTTP negotiation. A row whose input the implementation's value model
cannot represent (a lone surrogate in a language whose strings are Unicode
scalar values) does not apply to it. A row that decodes a deflate-packed
column needs the inflate capability; an implementation without it reports
`unsupported` for that row after the §6 checks that precede it. Within 1.x,
rows may be added, never changed or removed.
