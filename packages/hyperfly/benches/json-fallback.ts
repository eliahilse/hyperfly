import { encodeFor, negotiate, type JsonNegotiation } from "../src/http.js";
import { CodecRegistry, compileIR, type IRNode } from "../src/index.js";

// Extract origin/main's packages/hyperfly/src into a temporary directory, then
// pass its http.ts path so both versions run on the same Bun process and data.
const baselinePath = Bun.argv[2];
if (!baselinePath) throw new Error("usage: bun benches/json-fallback.ts /path/to/origin-main/src/http.ts");
const baseline = await import(baselinePath) as { encodeFor: typeof encodeFor };
const fields: Extract<IRNode, { kind: "struct" }>["fields"] = [
  { name: "id", type: { kind: "int" } }, { name: "name", type: { kind: "string" } },
  { name: "active", type: { kind: "bool" } }, { name: "score", type: { kind: "float64" } },
];
const registry = new CodecRegistry([compileIR({ kind: "array", element: { kind: "struct", fields } })]);
const byteRegistry = new CodecRegistry([compileIR({ kind: "array", element: { kind: "struct", fields: [
  ...fields, { name: "data", type: { kind: "bytes" } },
] } })]);
const rows = Array.from({ length: 10_000 }, (_, id) => ({ id, name: `row ${id}`, active: id % 2 === 0, score: id / 2 }));
const bytes = rows.map((row) => ({ ...row, data: new Uint8Array([0, 127, 128, 255]) }));
const samples = 31;
const iterations = 5;
let consumed = 0;
function time(encode: typeof encodeFor, value: unknown, decision: JsonNegotiation) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) consumed += (encode(decision, value).body as string).length;
  return (performance.now() - start) / iterations;
}
function median(values: number[]) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}
for (const [name, value, codecs] of [["encode no-bytes", rows, registry], ["encode bytes", bytes, byteRegistry]] as const) {
  const decision = negotiate(null, codecs);
  if (decision.kind !== "json") throw new Error("expected JSON negotiation");
  for (let i = 0; i < 12; i++) {
    time(baseline.encodeFor, value, decision);
    time(encodeFor, value, decision);
  }
  const main: number[] = [];
  const current: number[] = [];
  for (let i = 0; i < samples; i++) {
    if (i % 2 === 0) {
      main.push(time(baseline.encodeFor, value, decision));
      current.push(time(encodeFor, value, decision));
    } else {
      current.push(time(encodeFor, value, decision));
      main.push(time(baseline.encodeFor, value, decision));
    }
  }
  const before = median(main);
  const after = median(current);
  console.log(`${name}: origin/main=${before.toFixed(3)}ms current=${after.toFixed(3)}ms ratio=${(after / before).toFixed(3)} (${samples} interleaved samples, ${iterations} encodes/sample)`);
}
console.log(`Bun ${Bun.version}; consumed ${consumed} characters`);
