"""Deterministic decode/encode benchmarks inspired by apps/bench's API corpora.

Run with .venv/bin/python python/benchmarks/decode_bench.py. Compilation, payload
generation, equality checks and warmup are outside the timed region. Use --source
with an exported checkout's python/src to compare revisions with the same driver.
"""

from __future__ import annotations

import argparse
import gc
import json
import platform
import random
import statistics
import sys
from pathlib import Path
from time import perf_counter_ns


def struct(**fields):
    return {"kind": "struct", "fields": [{"name": name, "type": node} for name, node in fields.items()]}


def array(element):
    return {"kind": "array", "element": element}


def cases(rows):
    # Events, devices and feed-like values: wide structs, nested containers,
    # variable strings, byte blobs, enums, nullable and optional fields.
    rng = random.Random(0x4846)
    integer, floating, text = ({"kind": kind} for kind in ("int", "float64", "string"))
    record = struct(
        id=integer, at={"kind": "int", "min": 0}, value=floating,
        name=text, ok={"kind": "bool"}, region={"kind": "enum", "members": ["us", "eu", "ap"]},
        note=text, blob={"kind": "bytes"},
        actor=struct(id=text, email=text, verified={"kind": "bool"}),
    )
    record["fields"][6]["nullable"] = True
    record["fields"][7]["optional"] = True
    values = []
    for i in range(rows):
        row = dict(
            id=rng.randrange(-2**35, 2**35), at=1755000000000 + i * 1000,
            value=rng.uniform(-20000, 20000), name=f"device-{rng.randrange(100000):06d}-東京",
            ok=i % 5 != 0, region=["us", "eu", "ap"][i % 3],
            note=None if i % 4 == 0 else f"report {i}: café",
            actor=dict(id=f"usr_{i % 150:04d}", email=f"member{i % 150}@example.com", verified=i % 7 == 0),
        )
        if i % 5:
            row["blob"] = rng.randbytes(24)
        values.append(row)
    for plan in ("row", "columnar"):
        yield f"mixed/{plan}", array(record), values, dict(plan=plan, pack=False)

    nested = struct(route={"kind": "literal", "value": "devices"}, groups=array(struct(
        id=integer, devices=array(record), samples=array(floating),
    )))
    groups = [dict(id=i, devices=values[i:i + 25], samples=[rng.random() for _ in range(16)])
              for i in range(0, rows, 25)]
    for plan in ("row", "columnar"):
        yield f"nested/{plan}", nested, dict(route="devices", groups=groups), dict(plan=plan, pack=False)

    prose = [dict(body=f"Report {i}: " + " ".join(rng.choices(
        "the device reports temperature from the station near the river today".split(), k=65))) for i in range(rows)]
    yield "packed/columnar", array(struct(body=text)), prose, dict(plan="columnar")

    names = [f"usr_{i:04d}" for i in range(150)]
    emails = [f"member{i}@example.com" for i in range(150)]
    profile = {"version": 2, "shared": {"columns": [
        {"leaf": 0, "dict": names},
        {"leaf": 1, "derived": {"source": 0, "values": emails}},
        {"leaf": 2, "grammar": [{"lit": "evt_"}, {"num": {"base": 16, "len": 8, "case": "lower"}}]},
    ]}}
    profiled = [dict(actor=names[i % 150], email=emails[i % 150], event=f"evt_{i:08x}") for i in range(rows)]
    yield "profile/columnar", array(struct(actor=text, email=text, event=text)), profiled, dict(plan="columnar", profile=profile, pack=False)


def median_ms(operation, runs):
    samples = []
    for _ in range(runs):
        start = perf_counter_ns()
        result = operation()
        samples.append((perf_counter_ns() - start) / 1_000_000)
        # Release the previous result outside the timed region, with ordinary GC
        # enabled so allocation-heavy cases reflect serving actual responses.
        del result
    return statistics.median(samples)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=15)
    parser.add_argument("--rows", type=int, default=10000)
    parser.add_argument("--case", action="append", help="case name (repeatable)")
    parser.add_argument("--source", type=Path, help="override the hyperfly source directory")
    parser.add_argument("--json", type=Path, help="write machine-readable results")
    args = parser.parse_args()
    if args.runs < 15:
        parser.error("use at least 15 measured runs")
    if args.source:
        sys.path.insert(0, str(args.source.resolve()))
    from hyperfly import compile_ir

    print(f"Python {platform.python_version()} / {platform.platform()}; {args.rows} rows; median of {args.runs}; GC enabled")
    print(f"{'case':24} {'body bytes':>12} {'decode ms':>12} {'encode ms':>12}")
    results = []
    for name, ir, value, options in cases(args.rows):
        if args.case and name not in args.case:
            continue
        codec = compile_ir(ir, **options)
        body = codec.encode_body(value)
        assert codec.decode_body(body) == value, name
        for _ in range(3):
            codec.decode_body(body)
            codec.encode_body(value)
        gc.collect()
        decoded = median_ms(lambda: codec.decode_body(body), args.runs)
        encoded = median_ms(lambda: codec.encode_body(value), args.runs)
        results.append(dict(case=name, bytes=len(body), decode_ms=decoded, encode_ms=encoded))
        print(f"{name:24} {len(body):12d} {decoded:12.3f} {encoded:12.3f}", flush=True)
    if args.json:
        args.json.write_text(json.dumps(dict(python=platform.python_version(), rows=args.rows, runs=args.runs, results=results), indent=2) + "\n")


if __name__ == "__main__":
    main()
