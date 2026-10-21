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

For alternating baseline/current measurements in one process:

```sh
mkdir -p /tmp/hyperfly-python-decode-baseline
git archive origin/main python/src | tar -x -C /tmp/hyperfly-python-decode-baseline
.venv/bin/python python/benchmarks/decode_bench.py --runs 31 \
  --compare-source /tmp/hyperfly-python-decode-baseline/python/src \
  --json /tmp/hyperfly-paired.json
```

The JSON also records process CPU medians to help distinguish CPU cost from
scheduling delays. Run comparisons separately from tests and differential jobs.
Both codecs must produce identical body bytes and decoded values before timing.

## Final alternating comparison

`decode_results.json` records 31 alternating runs against the same exported
`origin/main`, with the runtime at `4efed61`. No validation jobs overlapped this
comparison. Median wall milliseconds:

| Case | Decode before | Decode after | Encode before | Encode after |
| --- | ---: | ---: | ---: | ---: |
| mixed/row | 151.717 | 59.720 | 142.100 | 121.348 |
| mixed/columnar | 21.975 | 18.898 | 227.466 | 225.447 |
| nested/row | 306.701 | 158.648 | 219.117 | 223.054 |
| nested/columnar | 62.025 | 49.740 | 220.375 | 199.691 |
| packed/columnar | 8.743 | 5.827 | 113.112 | 113.560 |
| profile/columnar | 4.335 | 3.652 | 154.040 | 144.685 |

Median process CPU milliseconds, excluding scheduling delays:

| Case | Decode before | Decode after | Encode before | Encode after |
| --- | ---: | ---: | ---: | ---: |
| mixed/row | 109.580 | 50.884 | 87.445 | 85.939 |
| mixed/columnar | 16.550 | 14.958 | 123.712 | 125.357 |
| nested/row | 130.222 | 62.143 | 98.883 | 99.359 |
| nested/columnar | 47.383 | 39.801 | 158.368 | 151.581 |
| packed/columnar | 7.716 | 5.193 | 93.052 | 90.510 |
| profile/columnar | 3.388 | 3.162 | 65.347 | 66.507 |

The row cases improve 2.15x and 2.10x in CPU time; wall gains are 2.54x and
1.93x. Columnar wall gains range from 1.16x to 1.50x, below 2x. Encode differences
are consistent with shared-host measurement noise: the largest increase is
1.8%, while encoder code and operation counts are identical. This does not
establish a 2x gain for every plan or case.

## Profiling and decisions

`cProfile.Profile().runcall(codec.decode_body, body)` after one decode warmup
showed repeated node dispatch, schema lookups and varint byte calls dominating
row decoding. On mixed/row, the optimized reader reduces calls from 1,986,017
to 610,520. The mixed/columnar count falls from 91,325 to 35,301; nested/columnar
from 300,387 to 164,209; packed/columnar from 40,070 to 67. Profiler wall times
are not used as speedup measurements because instrumentation penalizes calls.

Manual timing wrapped `_read_slices` and `_assemble` with `process_time_ns`,
over 15 mixed/columnar decodes. Prefix scanning fell from about 7.85 to 3.79 ms;
assembly remained about 22 ms inclusive of nested structs. These diagnostic
times were taken on a busy host; use the alternating benchmark for comparisons.

Readers bind field metadata, enum byte lengths, bounds, depth and column ordinals
at compile time. Compilation walks the IR iteratively, preserving compilation
near the caller's recursion limit. Float64 readers use `unpack_from`; varints
avoid a reader-method call per byte. Uniform length prefixes and minimal two-byte
varint columns use guarded batch paths, with the scalar path for other layouts.

Checks and budget charges stay in traversal order. Moving row byte charges past
later values or validating floats only after reading a complete array would
change which malformed input fails first, so those approaches were rejected.
Increasing the short-column threshold to 32 helped only about 6%; generated dict
assembly helped mixed columnar data about 11%. Neither experiment was retained.
Encoder/write function ASTs match `origin/main`; no encoder algorithm changed.
After warming both codecs, encode call counts also match exactly on all six
1,000-row cases (174,371 / 166,094 / 180,031 / 203,713 / 24,059 / 94,401).

## Validation

Runtime commit `4efed61`: `.venv/bin/pytest python/tests -q` passed all 4,940
tests on Python 3.13.7, including existing Hypothesis/fuzz and strict mypy tests.
The modified runtime and benchmark files also parse with Python's 3.10 syntax
grammar. Other Python interpreters were not installed on this host.

The full differential harness's seed 1 run at this commit checked 186,738 decode
cases, 12,700 compile cases, 28,972 encode cases, 75,090 reencodes, 20,136
roundtrips, 597 vector replays and 6,000 JSON exchange cases with zero divergences.
HTTP replay (125 cases) and live interop passed; all three drivers had zero
restarts. One packed-encode case reported only the allowed, deflate-dependent
limit refusal class.

Seed 2 checked 200,865 decode cases, 12,770 compile cases, 28,944 encode cases,
82,806 reencodes, 20,153 roundtrips, 597 vector replays and 6,000 JSON exchange
cases with zero divergences. HTTP replay and live interop passed, with zero
driver restarts. One packed-encode case had the same allowed refusal class.

Two earlier seed 2 attempts had non-reproducing Python watchdog timeouts on
different inputs. The first two saved inputs matched the baseline on direct
replay (under 4 ms for both revisions); minimization of the later input also
reported matching values. The passing rerun kept the default 20-second watchdog
and every check unchanged. The final timing comparison ran separately from validation.
