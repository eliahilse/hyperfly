import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { train } from "hyperfly";
import { compile, toIR } from "hyperfly/zod";
import { EventResponse, eventsCorpus } from "./corpora/events.js";
import { OrderResponse, ordersCorpus } from "./corpora/orders.js";
import { candlesProto, devicesProto, eventsProto, feedProto, ordersProto, type ProtoCodec } from "./proto.js";
import { candlesCorpus, devicesCorpus, feedCorpus, CandleResponse, DeviceResponse, FeedResponse } from "./traffic.js";

const enc = new TextEncoder();

const brotli = (bytes: Uint8Array, mode: number) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
      [constants.BROTLI_PARAM_MODE]: mode,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;

export interface CorpusResult {
  route: string;
  messages: number;
  json: number;
  gzip: number;
  brotli: number;
  protobuf: number;
  columnar: number;
  profiled: number;
  full: number;
  dictEntries: number;
  dictBytes: number;
  /** Requests until the out-of-band dictionary has paid for itself, or null if it never does. */
  breakEven: number | null;
}

export interface CorpusSuite {
  route: string;
  schema: unknown;
  corpus: readonly unknown[];
  proto: ProtoCodec;
}

/**
 * Per-message averages over a corpus of independent responses from one route.
 *
 * The profile is trained on the corpus and serves the corpus, which is what a real
 * deployment does: you train on your route's traffic and then serve that route. The
 * dictionary is an out-of-band artifact, so its size is reported alongside — a
 * dictionary that costs more than it saves is not a win, and the reader should be
 * able to see that for themselves.
 */
export function measureCorpus(suite: CorpusSuite): CorpusResult {
  const ir = toIR(suite.schema as never);
  const profile = train(ir, suite.corpus);
  const columnar = compile(suite.schema as never, { plan: "columnar" });
  const profiled = profile ? compile(suite.schema as never, { plan: "columnar", profile }) : columnar;

  let json = 0;
  let gzip = 0;
  let br = 0;
  let proto = 0;
  let col = 0;
  let prof = 0;
  let full = 0;

  for (const message of suite.corpus) {
    const j = enc.encode(JSON.stringify(message));
    json += j.length;
    gzip += gzipSync(j, { level: 6 }).length;
    br += brotli(j, constants.BROTLI_MODE_TEXT);

    proto += suite.proto.encode(message).length;
    col += columnar.encode(message as never).length;
    const p = profiled.encode(message as never);
    prof += p.length;
    full += brotli(p, constants.BROTLI_MODE_GENERIC);

    if (!Bun.deepEquals(profiled.decode(p), message, false)) {
      throw new Error(`${suite.route}: profiled round-trip mismatch`);
    }
  }

  const columns = profile?.shared.columns ?? [];
  const n = suite.corpus.length;
  const mean = (total: number) => Math.round(total / n);

  const dictBytes = columns.reduce(
    (sum, c) => sum + c.dict.reduce((m, e) => m + enc.encode(e).length + 1, 0),
    0,
  );
  const savedPerMessage = mean(col) - mean(prof);

  return {
    route: suite.route,
    messages: n,
    json: mean(json),
    gzip: mean(gzip),
    brotli: mean(br),
    protobuf: mean(proto),
    columnar: mean(col),
    profiled: mean(prof),
    full: mean(full),
    dictEntries: columns.reduce((sum, c) => sum + c.dict.length, 0),
    dictBytes,
    breakEven: savedPerMessage > 0 ? Math.ceil(dictBytes / savedPerMessage) : null,
  };
}

export function defaultSuites(messages = 500): CorpusSuite[] {
  return [
    { route: "GET /v1/candles", schema: CandleResponse, corpus: candlesCorpus(messages, 0xc9), proto: candlesProto() },
    { route: "GET /v1/devices", schema: DeviceResponse, corpus: devicesCorpus(messages, 0xd9), proto: devicesProto() },
    { route: "GET /v1/feed", schema: FeedResponse, corpus: feedCorpus(messages, 0xf9), proto: feedProto() },
    { route: "GET /v1/events", schema: EventResponse, corpus: eventsCorpus(messages, 0xe9), proto: eventsProto() },
    { route: "GET /v1/orders/:id", schema: OrderResponse, corpus: ordersCorpus(messages, 0x09), proto: ordersProto() },
  ];
}

export function runProfileSuite(suites: CorpusSuite[] = defaultSuites()): CorpusResult[] {
  const results = suites.map(measureCorpus);

  console.log("\ncorpora — per-message averages, profile trained on the route's own traffic");
  console.log("  route              msgs   json   gzip     br4  proto    col   prof   full   dictionary");
  for (const r of results) {
    const cell = (v: number) => String(v).padStart(6);
    console.log(
      `  ${r.route.padEnd(17)} ${String(r.messages).padStart(4)} ${cell(r.json)} ${cell(r.gzip)} ` +
        `${cell(r.brotli)} ${cell(r.protobuf)} ${cell(r.columnar)} ${cell(r.profiled)} ${cell(r.full)}   ` +
        `${r.dictEntries} entries / ${r.dictBytes}B` +
        (r.breakEven ? ` (pays for itself after ${r.breakEven} requests)` : ""),
    );
  }
  return results;
}
