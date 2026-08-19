import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from "node:zlib";
import { decode as cborDecode, encode as cborEncode } from "cbor-x";
import { compile } from "hyperfly/zod";
import { pack, unpack } from "msgpackr";
import { candlesProto, devicesProto, feedProto, type ProtoCodec } from "./proto.js";
import { CandleResponse, candlesPayload } from "./corpora/candles.js";
import { DeviceResponse, devicesPayload } from "./corpora/devices.js";
import { FeedResponse, feedPayload } from "./corpora/feed.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Contender {
  name: string;
  encode: () => Uint8Array;
  decode: (bytes: Uint8Array) => unknown;
}

function brotli(bytes: Uint8Array, quality: number, mode: number): Uint8Array {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_MODE]: mode,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

interface AnyCodec {
  encode(v: never): Uint8Array;
  decode(b: Uint8Array): unknown;
}

function contenders(payload: unknown, row: AnyCodec, col: AnyCodec, proto: ProtoCodec): Contender[] {
  const p = payload as never;
  return [
    {
      name: "json",
      encode: () => enc.encode(JSON.stringify(payload)),
      decode: (b) => JSON.parse(dec.decode(b)),
    },
    {
      name: "json+gzip6",
      encode: () => gzipSync(enc.encode(JSON.stringify(payload)), { level: 6 }),
      decode: (b) => JSON.parse(dec.decode(gunzipSync(b))),
    },
    {
      name: "json+br4",
      encode: () => brotli(enc.encode(JSON.stringify(payload)), 4, constants.BROTLI_MODE_TEXT),
      decode: (b) => JSON.parse(dec.decode(brotliDecompressSync(b))),
    },
    {
      name: "json+br11",
      encode: () => brotli(enc.encode(JSON.stringify(payload)), 11, constants.BROTLI_MODE_TEXT),
      decode: (b) => JSON.parse(dec.decode(brotliDecompressSync(b))),
    },
    {
      name: "protobuf",
      encode: () => proto.encode(payload),
      decode: (b) => proto.decode(b),
    },
    {
      name: "protobuf+br4",
      encode: () => brotli(proto.encode(payload), 4, constants.BROTLI_MODE_GENERIC),
      decode: (b) => proto.decode(new Uint8Array(brotliDecompressSync(b))),
    },
    {
      name: "msgpack",
      encode: () => pack(payload),
      decode: (b) => unpack(b),
    },
    {
      name: "msgpack+br4",
      encode: () => brotli(pack(payload), 4, constants.BROTLI_MODE_GENERIC),
      decode: (b) => unpack(brotliDecompressSync(b)),
    },
    {
      name: "cbor",
      encode: () => cborEncode(payload),
      decode: (b) => cborDecode(b),
    },
    {
      name: "cbor+br4",
      encode: () => brotli(cborEncode(payload), 4, constants.BROTLI_MODE_GENERIC),
      decode: (b) => cborDecode(brotliDecompressSync(b)),
    },
    {
      name: "hf-row",
      encode: () => row.encode(p),
      decode: (b) => row.decode(b),
    },
    {
      name: "hf-row+br4",
      encode: () => brotli(row.encode(p), 4, constants.BROTLI_MODE_GENERIC),
      decode: (b) => row.decode(new Uint8Array(brotliDecompressSync(b))),
    },
    {
      name: "hf-col",
      encode: () => col.encode(p),
      decode: (b) => col.decode(b),
    },
    {
      name: "hf-col+br4",
      encode: () => brotli(col.encode(p), 4, constants.BROTLI_MODE_GENERIC),
      decode: (b) => col.decode(new Uint8Array(brotliDecompressSync(b))),
    },
  ];
}

interface Timing {
  p50: number;
  p95: number;
}

function timeIt(fn: () => unknown, warmup: number, samples: number): Timing {
  let sink = 0;
  for (let i = 0; i < warmup; i++) {
    const out = fn();
    sink ^= (out as { length?: number }).length ?? 1;
  }
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = Bun.nanoseconds();
    const out = fn();
    times.push(Bun.nanoseconds() - start);
    sink ^= (out as { length?: number }).length ?? 1;
  }
  if (sink === 0x7fffffff) console.log("");
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(times.length * 0.5)]! / 1e6,
    p95: times[Math.floor(times.length * 0.95)]! / 1e6,
  };
}

interface Row {
  corpus: string;
  contender: string;
  bytes: number;
  vsJson: number;
  encodeP50: number;
  encodeP95: number;
  decodeP50: number;
  decodeP95: number;
}

function runCorpus(name: string, schema: unknown, payload: unknown, proto: ProtoCodec, warmup: number, samples: number): Row[] {
  const compileStart = Bun.nanoseconds();
  const rowCodec = compile(schema as never);
  const colCodec = compile(schema as never, { plan: "columnar" });
  const compileMs = (Bun.nanoseconds() - compileStart) / 1e6;

  const rows: Row[] = [];
  const list = contenders(payload, rowCodec as never, colCodec as never, proto);
  const jsonBytes = list[0]!.encode().length;

  for (const c of list) {
    const encoded = c.encode();
    const decoded = c.decode(encoded);
    if (!Bun.deepEquals(decoded, payload, true)) {
      throw new Error(`${name}/${c.name}: round-trip mismatch`);
    }
    const encodeTiming = timeIt(c.encode, warmup, samples);
    const decodeTiming = timeIt(() => c.decode(encoded), warmup, samples);
    rows.push({
      corpus: name,
      contender: c.name,
      bytes: encoded.length,
      vsJson: jsonBytes / encoded.length,
      encodeP50: encodeTiming.p50,
      encodeP95: encodeTiming.p95,
      decodeP50: decodeTiming.p50,
      decodeP95: decodeTiming.p95,
    });
  }

  console.log(`\n${name}  (codec compile ${compileMs.toFixed(2)}ms, json ${jsonBytes.toLocaleString()} B)`);
  console.log("  contender      bytes        vs json   enc p50/p95 ms    dec p50/p95 ms");
  for (const r of rows) {
    console.log(
      `  ${r.contender.padEnd(13)} ${String(r.bytes.toLocaleString()).padStart(9)}   ${r.vsJson.toFixed(2).padStart(6)}x   ` +
        `${r.encodeP50.toFixed(3).padStart(7)}/${r.encodeP95.toFixed(3).padEnd(8)}  ${r.decodeP50.toFixed(3).padStart(7)}/${r.decodeP95.toFixed(3)}`,
    );
  }
  return rows;
}

const SUITES = [
  { name: "candles-100", schema: CandleResponse, payload: candlesPayload(100, 0xc1), proto: candlesProto(), warmup: 50, samples: 200 },
  { name: "candles-1000", schema: CandleResponse, payload: candlesPayload(1000, 0xc2), proto: candlesProto(), warmup: 30, samples: 100 },
  { name: "devices-50", schema: DeviceResponse, payload: devicesPayload(50, 0xd1), proto: devicesProto(), warmup: 50, samples: 200 },
  { name: "devices-500", schema: DeviceResponse, payload: devicesPayload(500, 0xd2), proto: devicesProto(), warmup: 30, samples: 100 },
  { name: "feed-10", schema: FeedResponse, payload: feedPayload(10, 0xf1), proto: feedProto(), warmup: 50, samples: 200 },
  { name: "feed-50", schema: FeedResponse, payload: feedPayload(50, 0xf2), proto: feedProto(), warmup: 30, samples: 100 },
];

console.log("hyperfly bench — private harness, in-process timings. Not publishable numbers.");
console.log(`bun ${Bun.version} · ${process.platform}/${process.arch}`);

const all: Row[] = [];
for (const suite of SUITES) {
  all.push(...runCorpus(suite.name, suite.schema, suite.payload, suite.proto, suite.warmup, suite.samples));
}

await Bun.write(
  new URL("../results/results.json", import.meta.url).pathname,
  JSON.stringify(
    {
      generatedBy: "apps/bench/src/run.ts",
      caveat: "In-process, single-run, synthetic corpora. See README for what these numbers may and may not be used for.",
      bun: Bun.version,
      platform: `${process.platform}/${process.arch}`,
      rows: all,
    },
    null,
    2,
  ),
);
console.log("\nwrote results/results.json");
