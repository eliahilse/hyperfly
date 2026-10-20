import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/fingerprints.json" with { type: "json" };
import { serializeArtifact, type IRNode, type PlanLayout } from "../src/index.js";
import { fingerprintOf, toHex } from "../src/canonical.js";

describe("fingerprint vectors", () => {
  for (const c of vectors.cases) {
    test(c.name, () => {
      const canonical = serializeArtifact(c.ir as IRNode, c.plan as PlanLayout, (c as { profile?: never }).profile);
      expect(canonical).toBe(c.canonical);
      expect(toHex(fingerprintOf(canonical))).toBe(c.fingerprint);
    });
  }
});
