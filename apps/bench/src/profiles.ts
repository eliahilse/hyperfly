import { brotliCompressSync, constants } from "node:zlib";
import { compile, toIR } from "hyperfly/zod";
import { train } from "hyperfly";
import { DeviceResponse } from "./corpora/devices.js";
import { FeedResponse } from "./corpora/feed.js";
import { devicesTraffic, feedTraffic } from "./traffic.js";

const enc = new TextEncoder();
const br = (bytes: Uint8Array, mode: number) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
      [constants.BROTLI_PARAM_MODE]: mode,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;

/**
 * Profiles are trained on one slice of sampled traffic and measured on a held-out
 * slice, so what is reported is generalization rather than memorization.
 */
export function runProfileSuite(): void {
  const suites = [
    { name: "devices", schema: DeviceResponse, traffic: devicesTraffic(60, 50, 0xd7) },
    { name: "feed", schema: FeedResponse, traffic: feedTraffic(60, 12, 0xf7) },
  ] as const;

  console.log("\nprofiles — trained on 80% of sampled responses, measured on the held-out 20%");
  console.log("  corpus    json      json+br4  columnar  col+br4   profiled  prof+br4  dict");

  for (const suite of suites) {
    const ir = toIR(suite.schema as never);
    const profile = train(ir, suite.traffic.train);
    const columnar = compile(suite.schema as never, { plan: "columnar" });
    const profiled = compile(suite.schema as never, { plan: "columnar", profile });

    let json = 0;
    let jsonBr = 0;
    let col = 0;
    let colBr = 0;
    let prof = 0;
    let profBr = 0;

    for (const response of suite.traffic.holdout) {
      const j = enc.encode(JSON.stringify(response));
      json += j.length;
      jsonBr += br(j, constants.BROTLI_MODE_TEXT);
      const c = columnar.encode(response as never);
      col += c.length;
      colBr += br(c, constants.BROTLI_MODE_GENERIC);
      const p = profiled.encode(response as never);
      prof += p.length;
      profBr += br(p, constants.BROTLI_MODE_GENERIC);
      if (!Bun.deepEquals(profiled.decode(p), response, false)) {
        throw new Error(`${suite.name}: profiled round-trip mismatch`);
      }
    }

    const entries = profile?.shared.columns.reduce((n, c) => n + c.dict.length, 0) ?? 0;
    const cell = (v: number) => `${String(v).padStart(7)} `;
    console.log(
      `  ${suite.name.padEnd(9)} ${cell(json)} ${cell(jsonBr)} ${cell(col)} ${cell(colBr)} ${cell(prof)} ${cell(profBr)} ${entries}`,
    );
  }
}
