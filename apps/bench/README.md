# @hyperfly/bench

Private benchmark harness. Compares the v0 schema-compiled row codec against
JSON and generic compression on three deterministic synthetic corpora.

```bash
bun run build        # from the repo root, builds hyperfly first
cd apps/bench && bun run bench
```

## Corpora

| corpus | shape | expectation |
|---|---|---|
| candles | numeric OHLCV rows, f64-heavy | weak under plan `row`; the flagship under plan `columnar` (delta timestamps, scaled-decimal prices) |
| devices | enums, bounded ints, booleans | favorable for schema-only encoding under either plan |
| feed | prose bodies, ids, names | thinnest margin — text columns deflate inside the codec (packed string mode), nested authors flatten into leaf columns |

## Fairness rules

- Deterministic seeds; payloads identical across contenders, verified by
  round-trip deep-equality before any timing.
- gzip level 6 (zlib/Express default). Brotli q4 — what edges actually run on
  dynamic responses (Cloudflare's documented dynamic level) and the primary
  baseline for any realistic claim; q6 (ngx_brotli's default) for
  origin-compression setups; q11 is the offline ceiling for pre-compressed
  static assets — report it, never present it as a dynamic choice. TEXT mode
  + size hint for JSON inputs, GENERIC for binary.
- `hyperfly+br4` is included because transport compression exists in real
  deployments; it is a valid configuration, not an admission of failure.
- Encode/decode timed as complete pipelines (stringify+compress vs
  encode+compress), warmup before sampling, p50/p95 reported, outputs
  consumed to defeat dead-code elimination. Codec compile time reported
  separately (steady-state assumption: both peers hold the artifact).
- Wire bytes include hyperfly's full 19-byte envelope.
- Protobuf gets a fair schema, not a strawman: proper proto enums (identifier
  mapping applied both ways inside the timed pipeline), `sint32` for
  negative-heavy fields, `int64` for timestamps (decoded as Number — all
  corpus values sit inside 2^53). proto3 cannot represent null, so nullable
  fields map null↔unset; the corpora never emit empty strings on those
  fields, which keeps the inverse mapping lossless, and round-trips are
  verified against the original payload.
- MessagePack and CBOR run schemaless (their default mode — field names on
  the wire), which is the honest comparison: schema-aware is precisely the
  thing being measured against.
- Every binary contender gets the same +br4 stacking option hyperfly gets.
- Two known minor biases, disclosed rather than hidden: the route discriminator
  is a schema literal Hyperfly erases to zero bytes but Protobuf sends as a
  field (≈6–9 B/message in Hyperfly's favour), and the reported "codec compile"
  time covers both Hyperfly plan compilations while Protobuf's `Root.fromJSON`
  runs during suite construction outside the timer. Neither moves the byte
  ranking; both are why these numbers stay private until a fresh-process,
  matched-setup harness replaces them.

## What these numbers are NOT

In-process, single-machine, synthetic-corpus results. They exist to guide
development, not to be published. Public claims need: real-world frozen
payload snapshots, Protobuf (non-negotiable) plus MessagePack/CBOR baselines,
fresh-process runs with randomized contender order, and cold-start /
break-even reporting alongside steady-state. That harness lands with the
first public benchmark, not before.
