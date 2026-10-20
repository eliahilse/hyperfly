import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { compileIR, HyperflyError, serializeArtifact, train, validateIR, validateProfile, type IRNode, type Profile } from "../src/index.js";
import { loadArtifact } from "../src/http.js";
import { compile, toIR } from "../src/zod.js";

function arrays(count: number, leaf: IRNode = { kind: "bool" }): IRNode {
  let ir = leaf;
  for (let i = 0; i < count; i++) ir = { kind: "array", element: ir };
  return ir;
}

function arrayValue(count: number, leaf: unknown = true): unknown {
  let value = leaf;
  for (let i = 0; i < count; i++) value = [value];
  return value;
}

function rejectsNesting(run: () => unknown): void {
  expect(run).toThrow(HyperflyError);
  expect(run).toThrow(expect.objectContaining({ code: "ir", message: expect.stringContaining("nests deeper than 512") }));
}

const PROFILE_IR: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "a", type: { kind: "string" } }, { name: "b", type: { kind: "string" } }] },
};
const PROFILE: Profile = {
  version: 2,
  shared: {
    columns: [
      { leaf: 0, dict: ["id_01"], grammar: [{ lit: "id_" }, { num: { base: 10, len: 2, case: "lower" } }] },
      { leaf: 1, derived: { source: 0, values: ["one"] } },
    ],
  },
};

const structIR = (() => {
  let ir: IRNode = { kind: "bool" };
  for (let i = 0; i < 170; i++) ir = { kind: "struct", fields: [{ name: "v", type: ir }] };
  return ir;
})();
const structValue = (() => {
  let value: unknown = true;
  for (let i = 0; i < 170; i++) value = { v: value };
  return value;
})();
const nullableIR = (() => {
  let ir: IRNode = { kind: "bool" };
  for (let i = 0; i < 255; i++) ir = { kind: "array", element: { kind: "nullable", inner: ir } };
  return ir;
})();

const boundaryCases = [
  { name: "arrays", ir: arrays(510), value: arrayValue(510) },
  { name: "nullable nodes", ir: nullableIR, value: arrayValue(255) },
  { name: "struct fields", ir: structIR, value: structValue },
  { name: "enum members", ir: arrays(509, { kind: "enum", members: ["yes"] }), value: arrayValue(509, "yes") },
  { name: "empty fields", ir: arrays(509, { kind: "struct", fields: [] }), value: arrayValue(509, {}) },
];

describe("canonical artifact nesting", () => {
  for (const { name, ir, value } of boundaryCases) {
    test(`${name} at depth 512 compile and round-trip`, () => {
      validateIR(ir);
      expect(train(ir, [value])).toBeUndefined();
      for (const plan of ["row", "columnar"] as const) {
        const codec = compileIR(ir, { plan, pack: false, limits: { maxDepth: 512 } });
        expect(codec.artifact).toBe(serializeArtifact(ir, plan));
        expect(JSON.stringify(codec.decode(codec.encode(value)))).toBe(JSON.stringify(value));
        expect(loadArtifact(codec.artifact, codec.fingerprint).fingerprint).toBe(codec.fingerprint);
      }
    });

    test(`${name} at depth 513 fail before recursion`, () => {
      const tooDeep: IRNode = { kind: "array", element: ir };
      rejectsNesting(() => compileIR(tooDeep));
      rejectsNesting(() => compileIR(tooDeep, { plan: "columnar", profile: PROFILE }));
      rejectsNesting(() => validateIR(tooDeep));
      rejectsNesting(() => validateProfile(tooDeep, PROFILE));
      rejectsNesting(() => serializeArtifact(tooDeep));
      rejectsNesting(() => train(tooDeep, []));
    });
  }

  test("very deep and cyclic IR fail before recursion", () => {
    const cycle: IRNode = { kind: "array", element: { kind: "bool" } };
    cycle.element = cycle;
    for (const ir of [arrays(20_000), cycle]) {
      rejectsNesting(() => compileIR(ir));
      rejectsNesting(() => validateIR(ir));
      rejectsNesting(() => validateProfile(ir, PROFILE));
      rejectsNesting(() => serializeArtifact(ir));
      rejectsNesting(() => train(ir, []));
    }
  });

  test("profiles at their deepest canonical shape work with IR at depth 512", () => {
    const ir = arrays(506, PROFILE_IR);
    const value = arrayValue(506, [{ a: "id_01", b: "one" }]);
    validateProfile(ir, PROFILE);
    const codec = compileIR(ir, { plan: "columnar", profile: PROFILE, limits: { maxDepth: 512 }, pack: false });
    expect(codec.artifact).toBe(serializeArtifact(ir, "columnar", PROFILE));
    expect(JSON.stringify(codec.decode(codec.encode(value)))).toBe(JSON.stringify(value));
    expect(train(ir, [value, value])).toBeDefined();
    rejectsNesting(() => compileIR(arrays(1, ir), { plan: "columnar", profile: PROFILE }));
    rejectsNesting(() => validateProfile(arrays(1, ir), PROFILE));
    rejectsNesting(() => serializeArtifact(arrays(1, ir), "columnar", PROFILE));
    rejectsNesting(() => train(arrays(1, ir), []));
  });

  test("advisory profile hints do not contribute to canonical depth", () => {
    const baseline = compileIR(PROFILE_IR, { plan: "columnar", profile: PROFILE });
    for (const depth of [512, 513, 20_000]) {
      const profile = { ...PROFILE, hints: { nested: arrayValue(depth) } };
      validateProfile(PROFILE_IR, profile);
      const codec = compileIR(PROFILE_IR, { plan: "columnar", profile });
      expect(codec.fingerprint).toBe(baseline.fingerprint);
      expect(codec.artifact).toBe(serializeArtifact(PROFILE_IR, "columnar", profile));
      expect(Object.isFrozen(codec.profile!.hints!.nested)).toBe(true);
    }
  });

  test("Zod output enforces the canonical bound before descending", () => {
    let schema: z.ZodType = z.boolean();
    for (let i = 0; i < 510; i++) schema = z.array(schema);
    const ir = toIR(schema);
    validateIR(ir);
    const codec = compile(schema, { limits: { maxDepth: 512 } });
    const value = arrayValue(510);
    expect(JSON.stringify(codec.decode(codec.encode(value)))).toBe(JSON.stringify(value));
    rejectsNesting(() => toIR(z.array(schema)));
    rejectsNesting(() => compile(z.array(schema)));
    rejectsNesting(() => toIR(schema.nullable()));
    let nullable: z.ZodType = z.boolean();
    for (let i = 0; i < 255; i++) nullable = z.array(nullable.nullable());
    validateIR(toIR(nullable));
    rejectsNesting(() => toIR(z.array(nullable)));
  });

  test("Zod struct fields and enum arrays count toward the bound", () => {
    let struct: z.ZodType = z.boolean();
    for (let i = 0; i < 170; i++) struct = z.object({ v: struct });
    validateIR(toIR(struct));
    rejectsNesting(() => toIR(z.array(struct)));
    for (const leaf of [z.enum(["yes"]), z.object({})]) {
      let schema: z.ZodType = leaf;
      for (let i = 0; i < 509; i++) schema = z.array(schema);
      validateIR(toIR(schema));
      rejectsNesting(() => toIR(z.array(schema)));
    }
  });
});
