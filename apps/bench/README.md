# @hyperfly/bench

Private benchmark harness with timing and corpus/profile suites on deterministic
synthetic data.

```bash
bun run build        # from the repo root, builds hyperfly first
cd apps/bench && bun run bench
```

## Timing suite

`src/run.ts` measures candles (100/1,000 rows), devices (50/500 records), and feed
(10/50 posts). Contenders are `json`, `json+gzip6`, `json+br4`, `json+br6`,
`json+br11`, `protobuf`, `msgpack`, `cbor`, `hf-row`, and `hf-col`. Each binary
contender also has a `+br4` variant. MessagePack and CBOR are schemaless.

Each contender round-trips the same payload before timing. The suite reports wire
bytes and encode/decode p50/p95 after warmup, including serialization and
compression in each pipeline. Hyperfly bytes include the 19-byte envelope. Brotli
uses TEXT mode for JSON and GENERIC for binary, with a size hint for both.
Results are written to `results/results.json`.

## Corpus/profile suite

`src/profiles.ts` averages bytes per message over 500 responses per route:
candles, devices, feed, audit events, and single orders. It measures JSON, JSON
with gzip6 or Brotli q4, Protobuf, columnar Hyperfly, and profiled columnar
Hyperfly, including Brotli q4 variants of both Hyperfly codecs. The printed table
omits gzip. Profiled messages are checked for round-trip equality.

Profiles are trained and evaluated on the same synthetic corpus, with no held-out
data. Dictionary size is an approximation: UTF-8 dictionary and derived values
plus one byte per entry, and JSON-serialized grammar sizes. It excludes the full
artifact overhead. The reported request break-even uses this estimate and the
rounded average byte savings over unprofiled columnar Hyperfly.

## Limits

Timings are in-process on one machine, with fixed contender order. The reported
compile time includes both Hyperfly plans; Protobuf setup runs outside that timer.
Hyperfly omits the schema-literal route discriminator that Protobuf sends. These
synthetic results do not measure production traffic, cold starts, or network cost.
