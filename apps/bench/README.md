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
| candles | numeric OHLCV rows, f64-heavy | weak for v0 — raw f64 vs short JSON decimals; the columnar/delta plan is what this corpus is for |
| devices | enums, bounded ints, booleans | the favorable case for schema-only encoding |
| feed | prose bodies, ids, names | honest loss case — Brotli eats text, schemas don't |

## Fairness rules

- Deterministic seeds; payloads identical across contenders, verified by
  round-trip deep-equality before any timing.
- gzip level 6. Brotli q4 (labelled: latency-oriented dynamic setting) and q11
  (offline ceiling — report, don't pretend it's a dynamic choice), TEXT mode
  + size hint for JSON inputs, GENERIC for binary.
- `hyperfly+br4` is included because transport compression exists in real
  deployments; it is a valid configuration, not an admission of failure.
- Encode/decode timed as complete pipelines (stringify+compress vs
  encode+compress), warmup before sampling, p50/p95 reported, outputs
  consumed to defeat dead-code elimination. Codec compile time reported
  separately (steady-state assumption: both peers hold the artifact).
- Wire bytes include hyperfly's full 19-byte envelope.

## What these numbers are NOT

In-process, single-machine, synthetic-corpus results. They exist to guide
development, not to be published. Public claims need: real-world frozen
payload snapshots, Protobuf (non-negotiable) plus MessagePack/CBOR baselines,
fresh-process runs with randomized contender order, and cold-start /
break-even reporting alongside steady-state. That harness lands with the
first public benchmark, not before.
