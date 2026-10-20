# hyperfly

Binary compression for typed APIs at the edge of entropy.

Typed APIs already know what their data can contain. Production traffic reveals what
the data usually contains. Hyperfly uses both to compile a binary protocol for one
exact route, instead of shipping generic JSON through a generic compressor.

**Pre-release.** The wire format is specified, three implementations agree on it
byte-for-byte, and the benchmarks below are reproducible, but nothing is stable yet:
expect breaking changes before 1.0.

| Package | Install | Docs |
|---|---|---|
| TypeScript, Zod adapter, HTTP | `npm install hyperfly@next zod` | [packages/hyperfly](packages/hyperfly/README.md) |
| Python, Pydantic adapter, HTTP | `pip install --pre "hyperfly[pydantic]"` | [python](python/README.md) |
| Rust codec | `cargo add hyperfly-core` | [rust](rust/README.md) |

Zod and Pydantic are needed only for the schema adapters; the codec and HTTP layers
run without them.

## What it costs on the wire

Bytes per message, averaged over 500-message corpora (`bun run build --filter=hyperfly`, then
`cd apps/bench && bun run bench`):

| route | JSON | JSON+Brotli | Protobuf | Hyperfly | Profiled |
|---|---|---|---|---|---|
| audit events | 12,687 | 2,512 | 7,190 | 2,013 | **574** |
| device telemetry | 7,994 | 1,422 | 2,007 | 755 | **542** |
| social feed | 6,863 | 2,294 | 4,396 | 1,871 | **1,466** |
| single order | 782 | 408 | 388 | 271 | **180** |
| OHLCV candles | 3,225 | 842 | 2,034 | **384** | **384** |

Read the spread rather than the best row. Training is worth 71% on audit logs —
recurring values become dictionary codes, machine-made ids travel as grammar
lanes, one column derives from another — and nothing at all on candles, whose
only string sits outside the array. The corpora are synthetic, shaped like real
routes but not captured from one, and no production traffic has been measured yet.

## Repository

```
spec/              the authority: wire format, plans, negotiation, golden vectors
packages/hyperfly  TypeScript reference implementation, zod adapter, HTTP layer
python/            Python implementation, pydantic adapter, HTTP helpers
rust/              Rust codec (the hyperfly-core crate)
apps/interop       a TS server and a Python client over real HTTP, run by CI
apps/bench         corpora and the benchmark harness
apps/web           hyperfly.dev
packages/tooling   shared ESLint and TypeScript configuration
packages/lb        legacy load balancer, previously published as `hyperfly@0.1.x`
```

The specifications are normative and the implementations are not. A fourth
implementation ports against [the golden vectors](spec/vectors), not against this
code.

- [wire v0](spec/wire-v0.md) — envelope, varints, bitmaps, node encodings, canonical
  artifacts, decoder limits
- [plan columnar v5](spec/plan-columnar-v5.md) — column layout, frame-of-reference
  bit packing, scaled-decimal and XOR numerics, packed text, trained dictionaries,
  grammar lanes, derived columns
- [negotiation v1](spec/negotiation-v1.md) — how peers agree on binary, how a client
  bootstraps, how a profile rotates without a cutover

The [golden vectors](spec/vectors), which every implementation runs (`accept.json`
only where HTTP negotiation is implemented, in TypeScript and Python):

- `vectors.json` — valid encode/decode pairs and invalid inputs, row plan
- `columnar.json` — the columnar plan, with and without profiles
- `fingerprints.json` — IR to canonical artifact text to fingerprint
- `limits.json` — each decoder and encoder limit just at and just past its bound
- `bytes.json` — the per-body byte budget, including packed string columns
- `ir.json` — invalid IR and valid near misses
- `accept.json` — `Hyperfly-Accept` parsing

## Development

```bash
bun install
bun run lint && bun run check-types && bun run test   # TypeScript
pytest python/tests -q                                # Python, after pip install "./python[test]"
cargo test --manifest-path rust/Cargo.toml            # Rust
```

CI runs all three suites with lint, type and clippy checks, a Python version
matrix, the Rust MSRV, package checks on the npm tarball, and the cross-language
interop exchange on every pull request and every push to `main`. [CONTRIBUTING.md](CONTRIBUTING.md) covers
changesets and how releases are published.

[Stability and versioning](STABILITY.md) covers compatibility; [the security policy](SECURITY.md) covers vulnerability reporting.

## License

[Apache License 2.0](LICENSE)
