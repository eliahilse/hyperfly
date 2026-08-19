import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/fingerprints.json" with { type: "json" };
import { fingerprintOf, serializeArtifact, toHex, type IRNode, type PlanLayout } from "../src/index.js";

describe("fingerprint vectors", () => {
  for (const c of vectors.cases) {
    test(c.name, () => {
      const canonical = serializeArtifact(c.ir as IRNode, c.plan as PlanLayout);
      expect(canonical).toBe(c.canonical);
      expect(toHex(fingerprintOf(canonical))).toBe(c.fingerprint);
    });
  }
});
