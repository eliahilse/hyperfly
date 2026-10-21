// Regenerate from the repository root: bun python/tests/fixtures/train_parity.ts
import { deflateRawSync } from "node:zlib";
import { z } from "../../../packages/hyperfly/node_modules/zod";
import { compileIR, train, type IRNode, type TrainOptions } from "../../../packages/hyperfly/src/index.js";
import { toIR } from "../../../packages/hyperfly/src/zod.js";
import {
  CandleResponse, DeviceResponse, FeedResponse,
  candlesCorpus, devicesCorpus, feedCorpus,
} from "../../../apps/bench/src/traffic.js";

const rows = z.array(z.object({ s: z.string() }));
const pair = z.array(z.object({ a: z.string(), b: z.string().optional() }));
const samples = (values: string[][]) => values.map((batch) => batch.map((s) => ({ s })));
const cases: { name: string; ir: IRNode; samples: unknown[]; options: TrainOptions }[] = [
  { name: "devices", ir: toIR(DeviceResponse), samples: devicesCorpus(60, 42), options: {} },
  { name: "candles", ir: toIR(CandleResponse), samples: candlesCorpus(60, 42), options: {} },
  { name: "feed", ir: toIR(FeedResponse), samples: feedCorpus(60, 42), options: {} },
  { name: "hex-grammar", ir: toIR(rows), samples: samples([["id_00af", "id_beef"], ["id_cafe", "id_12ff"]]), options: {} },
  { name: "decimal-grammar", ir: toIR(rows), samples: samples([["v2-0001-x", "v2-0002-x"], ["v2-0003-x", "v2-0004-x"]]), options: { minOccurrences: 1, maxEntries: 0 } },
  { name: "derivation", ir: toIR(pair), samples: [
    [{ a: "u1", b: "kim@x.io" }, { a: "u2", b: "lee@x.io" }],
    [{ a: "u1", b: "kim@x.io" }, { a: "u2", b: "lee@x.io" }],
  ], options: { minOccurrences: 2, maxEntries: 2 } },
];

const fixtures = cases.map((entry) => {
  const profile = train(entry.ir, entry.samples, entry.options);
  const codec = compileIR(entry.ir, { plan: "columnar", profile });
  return {
    ...entry,
    // Lossless storage keeps all 60 full messages per corpus within the fixture budget.
    samples: {
      encoding: "deflate-raw-base64",
      data: deflateRawSync(Buffer.from(JSON.stringify(entry.samples)), { level: 9 }).toString("base64"),
    },
    profile: profile ?? null,
    fingerprint: codec.fingerprint,
  };
});
const json = JSON.stringify(fixtures) + "\n";
if (Buffer.byteLength(json) >= 400_000) throw new Error("fixture exceeds 400 KB");
await Bun.write(new URL("./train_parity.json", import.meta.url), json);
for (const entry of fixtures) console.log(`${entry.name}: ${entry.fingerprint}`);
console.log(`${Buffer.byteLength(json)} bytes`);
