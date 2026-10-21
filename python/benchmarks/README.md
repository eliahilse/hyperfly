# Python codec timings

Run `.venv/bin/python python/benchmarks/decode_bench.py --json /tmp/decode.json`
from the repository root. Each case measures 15 runs after three warmups, with
10,000 records, GC enabled, compilation and round-trip checks outside timing.
Both decode and encode use the body API. Payload generation is deterministic.

Initial baseline: `origin/main` at `22cf2a9d5b8890c70697cafbc743e141afe7d7c7`,
Python 3.13.7, macOS 26.2, Apple Silicon. The script was added without changing
the runtime. Shared-host contention affects these wall-clock measurements;
comparisons should remeasure both revisions in the same session.

| Case | Body bytes | Decode median ms | Encode median ms |
| --- | ---: | ---: | ---: |
| mixed/row | 1,099,296 | 150.021 | 128.732 |
| mixed/columnar | 986,823 | 20.156 | 177.673 |
| nested/row | 1,152,165 | 130.830 | 91.427 |
| nested/columnar | 1,050,769 | 85.595 | 173.846 |
| packed/columnar | 527,230 | 11.656 | 105.299 |
| profile/columnar | 10,012 | 2.579 | 70.638 |

The mixed records cover safe integers, floats, UTF-8 strings, booleans, enums,
nullable and optional fields, bytes, and a nested actor struct. The nested case
groups the same records into 400 variable arrays and adds float arrays. Packed
prose resembles the feed corpus. The profile combines a dictionary source,
derived emails, and hexadecimal event ID grammar lanes.

To measure another revision without changing the benchmark driver, export that
revision's `python/src` under `/tmp` and pass `--source /tmp/export/python/src`.
