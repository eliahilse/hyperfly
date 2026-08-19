import { serializeArtifact, fingerprintOf, toHex, type IRNode, type PlanLayout } from "../../packages/hyperfly/src/index.js";

const CASES: { name: string; ir: IRNode }[] = [
  { name: "bool", ir: { kind: "bool" } },
  { name: "bounded-int", ir: { kind: "int", min: 0, max: 100 } },
  { name: "enum", ir: { kind: "enum", members: ["1m", "5m", "1h", "1d"] } },
  {
    name: "candles-response",
    ir: {
      kind: "struct",
      fields: [
        { name: "route", type: { kind: "literal", value: "candles" } },
        {
          name: "candles",
          type: {
            kind: "array",
            element: {
              kind: "struct",
              fields: [
                { name: "t", type: { kind: "int", min: 0 } },
                { name: "o", type: { kind: "float64" } },
                { name: "h", type: { kind: "float64" } },
                { name: "l", type: { kind: "float64" } },
                { name: "c", type: { kind: "float64" } },
                { name: "v", type: { kind: "float64" } },
              ],
            },
          },
        },
        { name: "cursor", type: { kind: "string" }, optional: true },
      ],
    },
  },
  { name: "escaping", ir: { kind: "literal", value: 'a"b\\c' } },
];

const PROFILED: { name: string; ir: IRNode; profile: { version: 1; shared: { columns: { leaf: number; dict: string[] }[] } } }[] = [
  {
    name: "profiled-single",
    ir: { kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] } },
    profile: { version: 1, shared: { columns: [{ leaf: 0, dict: ['a"q', "b\\s", "c\u0001", "🚀"] }] } },
  },
  {
    name: "profiled-two-arrays",
    ir: {
      kind: "struct",
      fields: [
        { name: "a", type: { kind: "array", element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] } } },
        { name: "b", type: { kind: "array", element: { kind: "struct", fields: [{ name: "t", type: { kind: "string" } }] } } },
      ],
    },
    profile: { version: 1, shared: { columns: [{ leaf: 1, dict: ["only-second"] }] } },
  },
];

const LAYOUTS: PlanLayout[] = ["row", "columnar"];
const out = LAYOUTS.flatMap((layout) =>
  CASES.map(({ name, ir }) => {
    const canonical = serializeArtifact(ir, layout);
    return { name: `${name}@${layout}`, plan: layout, ir, canonical, fingerprint: toHex(fingerprintOf(canonical)) };
  }),
);

for (const c of PROFILED) {
  const canonical = serializeArtifact(c.ir, "columnar", c.profile);
  out.push({ name: c.name, plan: "columnar", ir: c.ir, profile: c.profile, canonical, fingerprint: toHex(fingerprintOf(canonical)) } as never);
}

await Bun.write(
  new URL("./fingerprints.json", import.meta.url).pathname,
  JSON.stringify({ description: "IR → canonical artifact text → fingerprint (first 16 bytes of SHA-256, hex). Locks spec §5.", cases: out }, null, 2) + "\n",
);
console.log("wrote fingerprints.json");
