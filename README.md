# hyperfly

Binary compression for typed APIs at the edge of entropy.

Typed APIs already know what their data can contain. Production traffic reveals what
the data usually contains. Hyperfly uses both to compile a binary protocol for one
exact route, instead of shipping generic JSON through a generic compressor.

**Pre-release.** The wire format is specified, three implementations agree on it
byte-for-byte, and the benchmarks below are reproducible — but nothing is published
and nothing is stable.

## What it costs on the wire

Bytes per message, averaged over 500-message corpora (`bun run bench`):

| route | JSON | JSON+Brotli | Protobuf | Hyperfly | + Brotli | Profiled |
|---|---|---|---|---|---|---|
| audit events | 12,687 | 2,512 | 7,190 | 2,109 | 2,054 | **823** |
| device telemetry | 7,994 | 1,422 | 2,007 | 896 | 818 | **638** |
| social feed | 6,863 | 2,294 | 4,396 | 1,908 | 1,902 | **1,535** |
| single order | 782 | 408 | 388 | 271 | 273 | **188** |
| OHLCV candles | 3,225 | 842 | 2,034 | 496 | **372** | 372 |

Read the spread rather than the best row. Training is worth 57% on audit logs, where
the same user agents recur on every request, and nothing at all on candles, whose
only string sits outside the array. The corpora are synthetic — shaped like real
routes, not captured from one — and no production traffic has been measured yet.

## Repository

```
spec/              the authority: wire format, plans, negotiation, golden vectors
packages/hyperfly  TypeScript reference implementation, zod adapter, HTTP layer
python/            Python implementation and pydantic adapter
rust/              Rust core
apps/interop       a TS server and a Python client over real HTTP, run by CI
apps/bench         corpora and the benchmark harness
apps/web           hyperfly.dev
packages/lb        legacy load balancer, previously published as `hyperfly@0.1.x`
```

The specifications are normative and the implementations are not. A fourth
implementation ports against [the golden vectors](spec/vectors), not against this
code.

- [wire v0](spec/wire-v0.md) — envelope, varints, bitmaps, node encodings, canonical
  artifacts, decoder limits
- [plan columnar v3](spec/plan-columnar-v3.md) — column layout, delta and XOR and
  scaled-decimal numerics, packed text, trained dictionaries
- [negotiation v1](spec/negotiation-v1.md) — how peers agree on binary, how a client
  bootstraps, how a profile rotates without a cutover

## Development

```bash
bun install
bun run test            # TypeScript
pytest python/tests -q  # Python
cargo test --manifest-path rust/Cargo.toml
cd apps/bench && bun run bench
```

CI runs all three suites, a Python version matrix, and the cross-language interop
exchange on every push.

## License

[Apache License 2.0](LICENSE)
