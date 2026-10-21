import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/bytes.json" with { type: "json" };
import { compileIR, DEFAULT_LIMITS, type Limits, type IRNode, type Profile } from "../src/index.js";
import { toHex } from "../src/canonical.js";
import { HyperflyError } from "../src/errors.js";
import { fromHex, revive } from "./vector-values.js";

interface ByteVector {
  name: string;
  plan: string;
  ir: unknown;
  limits?: Partial<Limits>;
  profile?: unknown;
  inflate?: boolean;
  value?: unknown;
  hex?: string;
  error?: string;
}

function codecFor(v: ByteVector) {
  return compileIR(v.ir as IRNode, {
    plan: v.plan === "columnar" ? "columnar" : "row",
    ...(v.limits ? { limits: v.limits } : {}),
    ...(v.profile ? { profile: v.profile as Profile } : {}),
    ...(v.inflate === false ? { pack: false as const } : {}),
  });
}

function expectCode(run: () => unknown, code: string | undefined): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(HyperflyError);
    expect((err as HyperflyError).code as string).toBe(code!);
    return;
  }
  throw new Error(`expected a ${code} error`);
}

const sections = vectors as unknown as Record<"valid" | "invalidDecode" | "invalidEncode" | "packedDecode", ByteVector[]>;

describe("byte budget vectors: valid", () => {
  for (const v of sections.valid) {
    test(v.name, () => {
      const codec = codecFor(v);
      expect(toHex(codec.encodeBody(revive(v.value)))).toBe(v.hex!);
      expect(codec.decodeBody(fromHex(v.hex!))).toEqual(revive(v.value) as never);
    });
  }
});

describe("byte budget vectors: invalid decode", () => {
  for (const v of sections.invalidDecode) {
    test(v.name, () => expectCode(() => codecFor(v).decodeBody(fromHex(v.hex!)), v.error));
  }
});

describe("byte budget vectors: invalid encode", () => {
  for (const v of sections.invalidEncode) {
    test(v.name, () => expectCode(() => codecFor(v).encodeBody(revive(v.value)), v.error));
  }
});

describe("byte budget vectors: packed decode", () => {
  for (const v of sections.packedDecode) {
    test(v.name, () => {
      expect(codecFor(v).decodeBody(fromHex(v.hex!))).toEqual(revive(v.value) as never);
    });
  }
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(HyperflyError);
    return (err as HyperflyError).code;
  }
  throw new Error("expected a failure");
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

const STRINGS: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};

describe("byte budget charge points", () => {
  test("defaults", () => {
    expect(DEFAULT_LIMITS.maxTotalBytes).toBe(2 ** 26);
    expect(DEFAULT_LIMITS.maxByteAmplification).toBe(64);
  });

  test("a row string or bytes value is charged after maxByteLength and before its bytes are read", () => {
    for (const kind of ["string", "bytes"] as const) {
      const ir: IRNode = { kind };
      expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 4 } }).decodeBody(fromHex("05616263")))).toBe("limit");
      expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 5 } }).decodeBody(fromHex("05616263")))).toBe("truncated");
      expect(messageOf(() => compileIR(ir, { limits: { maxTotalBytes: 4, maxByteLength: 4 } }).decodeBody(fromHex("05"))))
        .not.toContain("byte budget");
    }
  });

  test("a row enum member is charged after its range check", () => {
    const ir: IRNode = { kind: "enum", members: ["aaaa", "b"] };
    expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 0 } }).decodeBody(fromHex("02")))).toBe("range");
    expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 3 } }).decodeBody(fromHex("00")))).toBe("limit");
    expect(compileIR(ir, { limits: { maxTotalBytes: 1 } }).decodeBody(fromHex("01"))).toBe("b");
  });

  test("members and literals are charged in UTF-8 bytes", () => {
    const ir: IRNode = {
      kind: "struct",
      fields: [
        { name: "e", type: { kind: "enum", members: ["é"] } },
        { name: "l", type: { kind: "literal", value: "😀" } },
      ],
    };
    expect(compileIR(ir, { limits: { maxTotalBytes: 6 } }).decodeBody(fromHex("00"))).toEqual({ e: "é", l: "😀" });
    expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 5 } }).decodeBody(fromHex("00")))).toBe("limit");
    expect(codeOf(() => compileIR(ir, { limits: { maxTotalBytes: 5 } }).encodeBody({ e: "é", l: "😀" }))).toBe("limit");
  });

  test("a zero budget still decodes empty values", () => {
    const ir: IRNode = {
      kind: "struct",
      fields: [
        { name: "s", type: { kind: "string" } },
        { name: "b", type: { kind: "bytes" } },
        { name: "l", type: { kind: "literal", value: "" } },
        { name: "n", type: { kind: "literal", value: 3 } },
      ],
    };
    const value = { s: "", b: new Uint8Array(), l: "", n: 3 };
    expect(toHex(compileIR(ir, { limits: { maxTotalBytes: 0 } }).encodeBody(value))).toBe("0000");
    for (const plan of ["row", "columnar"] as const) {
      const codec = compileIR({ kind: "array", element: ir }, { plan, limits: { maxTotalBytes: 0, maxByteAmplification: 0 } });
      expect(codec.decodeBody(codec.encodeBody([value, value]))).toEqual([value, value]);
    }
  });

  test("unbounded limits do not overflow the cap", () => {
    const limits = { maxTotalBytes: Number.MAX_SAFE_INTEGER, maxByteAmplification: Number.MAX_SAFE_INTEGER };
    const codec = compileIR({ kind: "string" }, { limits });
    expect(toHex(codec.encodeBody("a"))).toBe("0161");
    expect(codec.decodeBody(fromHex("0161"))).toBe("a");
  });

  test("a plain string column and a bytes column charge each value before reading it", () => {
    const tight = compileIR(STRINGS, { plan: "columnar", limits: { maxTotalBytes: 4 } });
    expect(codeOf(() => tight.decodeBody(fromHex("01000561")))).toBe("limit");
    expect(codeOf(() => compileIR(STRINGS, { plan: "columnar" }).decodeBody(fromHex("01000561")))).toBe("truncated");
    const bytes: IRNode = { kind: "array", element: { kind: "struct", fields: [{ name: "b", type: { kind: "bytes" } }] } };
    expect(codeOf(() => compileIR(bytes, { plan: "columnar", limits: { maxTotalBytes: 4 } }).decodeBody(fromHex("010561")))).toBe("limit");
    expect(codeOf(() => compileIR(bytes, { plan: "columnar" }).decodeBody(fromHex("010561")))).toBe("truncated");
  });

  test("a dictionary hit is charged after its code range and maxByteLength checks", () => {
    const profile = { version: 1 as const, shared: { columns: [{ leaf: 0, dict: ["abcd"] }] } };
    const at = (limits: Partial<Limits>) => compileIR(STRINGS, { plan: "columnar", profile, limits });
    expect(codeOf(() => at({ maxTotalBytes: 0 }).decodeBody(fromHex("01010202")))).toBe("range");
    expect(messageOf(() => at({ maxTotalBytes: 3 }).decodeBody(fromHex("01010101")))).toContain("byte budget");
    expect(messageOf(() => at({ maxTotalBytes: 3, maxByteLength: 3 }).decodeBody(fromHex("01010101")))).toContain(
      "reconstructed string length exceeds limit",
    );
    expect(at({ maxTotalBytes: 4 }).decodeBody(fromHex("01010101"))).toEqual([{ s: "abcd" }]);
  });

  describe("grammar values", () => {
    const profile = {
      version: 2 as const,
      shared: { columns: [{ leaf: 0, grammar: [{ lit: "id-" }, { num: { base: 10 as const, len: 2, case: "lower" as const } }] }] },
    };
    const at = (limits: Partial<Limits> = {}) => compileIR(STRINGS, { plan: "columnar", profile, limits });

    test("each matched row is charged its rendered length", () => {
      expect(at({ maxTotalBytes: 10 }).decodeBody(fromHex("020300000107"))).toEqual([{ s: "id-01" }, { s: "id-07" }]);
      expect(codeOf(() => at({ maxTotalBytes: 9 }).decodeBody(fromHex("020300000107")))).toBe("limit");
    });

    test("a lane range is the row's own check, made in row order", () => {
      // row 0 matched with lane value 100 >= 10^2, row 1 an escape of 3 bytes
      expect(codeOf(() => at({ maxTotalBytes: 0 }).decodeBody(fromHex("02030102006403616263")))).toBe("range");
      // row 0 an over-budget escape, row 1 matched with lane value 100
      expect(codeOf(() => at({ maxTotalBytes: 2 }).decodeBody(fromHex("02030101006403616263")))).toBe("limit");
      expect(codeOf(() => at().decodeBody(fromHex("02030101006403616263")))).toBe("range");
    });

    test("every lane mode defers its range checks to row order", () => {
      const hex = { version: 2 as const, shared: { columns: [{ leaf: 0, grammar: [{ lit: "ord_" }, { num: { base: 16 as const, len: 1, case: "lower" as const } }] }] } };
      const codec = compileIR(STRINGS, { plan: "columnar", profile: hex, pack: false, limits: { maxTotalBytes: 4 } });
      for (const lane of ["000010", "010020", "0200050002", "03002000", "040000050210"]) {
        expect(codeOf(() => codec.decodeBody(fromHex(`020300${lane}`)))).toBe("limit");
      }
      expect(codeOf(() => codec.decodeBody(fromHex("020300001000")))).toBe("range");
      expect(codeOf(() => codec.decodeBody(fromHex("0203000010")))).toBe("truncated");
      expect(codeOf(() => codec.decodeBody(fromHex("0203000200050080")))).toBe("bitmap");
      expect(codeOf(() => codec.decodeBody(fromHex("02030101001001ff")))).toBe("utf8");
    });

    test("lane padding stays structural", () => {
      expect(codeOf(() => at({ maxTotalBytes: 2 }).decodeBody(fromHex("020301010200010303616263")))).toBe("bitmap");
    });
  });

  test("a derived value is charged after its source lookup", () => {
    const IR: IRNode = {
      kind: "array",
      element: {
        kind: "struct",
        fields: [
          { name: "a", type: { kind: "string" } },
          { name: "b", type: { kind: "string" } },
        ],
      },
    };
    const profile = {
      version: 2 as const,
      shared: { columns: [{ leaf: 0, dict: ["x"] }, { leaf: 1, derived: { source: 0, values: ["y"] } }] },
    };
    const at = (maxTotalBytes: number) => compileIR(IR, { plan: "columnar", profile, limits: { maxTotalBytes } });
    expect(codeOf(() => at(2).decodeBody(fromHex("0200017a017804010201ff")))).toBe("range");
    expect(at(4).decodeBody(fromHex("020001780178040102017a"))).toEqual([
      { a: "x", b: "y" },
      { a: "x", b: "z" },
    ]);
    expect(codeOf(() => at(3).decodeBody(fromHex("020001780178040102017a")))).toBe("limit");
  });

  test("an enum column charges each member after its range check, a width-zero column all at once", () => {
    const IR: IRNode = {
      kind: "array",
      element: { kind: "struct", fields: [{ name: "e", type: { kind: "enum", members: ["aaaa", "b", "c"] } }] },
    };
    expect(codeOf(() => compileIR(IR, { plan: "columnar", limits: { maxTotalBytes: 0 } }).decodeBody(fromHex("0203")))).toBe("range");
    expect(codeOf(() => compileIR(IR, { plan: "columnar", limits: { maxTotalBytes: 3 } }).decodeBody(fromHex("020c")))).toBe("limit");
    const single: IRNode = {
      kind: "array",
      element: { kind: "struct", fields: [{ name: "e", type: { kind: "enum", members: ["abcd"] } }] },
    };
    expect(compileIR(single, { plan: "columnar", limits: { maxTotalBytes: 12 } }).decodeBody(fromHex("03"))).toHaveLength(3);
    expect(codeOf(() => compileIR(single, { plan: "columnar", limits: { maxTotalBytes: 11 } }).decodeBody(fromHex("03")))).toBe("limit");
  });

  test("a packed column is charged its declared total once, before the blob and the capability check", () => {
    const value = [{ s: "a".repeat(40) }, { s: "a".repeat(40) }];
    const packed = compileIR(STRINGS, { plan: "columnar" }).encodeBody(value);
    expect(packed[1]).toBe(0x02);
    expect(compileIR(STRINGS, { plan: "columnar", limits: { maxTotalBytes: 80 } }).decodeBody(packed)).toEqual(value);
    const tight = { maxTotalBytes: 79 };
    expect(codeOf(() => compileIR(STRINGS, { plan: "columnar", limits: tight }).decodeBody(packed.subarray(0, 4)))).toBe("limit");
    expect(codeOf(() => compileIR(STRINGS, { plan: "columnar", limits: tight, pack: false }).decodeBody(packed))).toBe("limit");
    expect(codeOf(() => compileIR(STRINGS, { plan: "columnar", pack: false }).decodeBody(packed.subarray(0, 4)))).toBe("unsupported");
  });

  test("the budget is shared by sibling and nested columnar arrays", () => {
    const IR: IRNode = {
      kind: "struct",
      fields: [
        { name: "a", type: STRINGS },
        { name: "b", type: { kind: "array", element: STRINGS } },
      ],
    };
    const value = { a: [{ s: "ab" }], b: [[{ s: "cd" }], [{ s: "ef" }]] };
    const body = compileIR(IR, { plan: "columnar", pack: false }).encodeBody(value);
    expect(compileIR(IR, { plan: "columnar", limits: { maxTotalBytes: 6 } }).decodeBody(body)).toEqual(value);
    expect(codeOf(() => compileIR(IR, { plan: "columnar", limits: { maxTotalBytes: 5 } }).decodeBody(body))).toBe("limit");
  });

  test("the encoder refuses past maxTotalBytes early and past the amplified cap on the final body", () => {
    const ir: IRNode = { kind: "array", element: { kind: "literal", value: "x".repeat(64) } };
    const two = Array.from({ length: 2 }, () => "x".repeat(64));
    expect(messageOf(() => compileIR(ir, { limits: { maxTotalBytes: 127 } }).encodeBody(two))).toContain("$[1]");
    expect(messageOf(() => compileIR(ir).encodeBody([...two, "x".repeat(64)]))).toContain("a 1-byte body");
    expect(toHex(compileIR(ir).encodeBody(two))).toBe("02");
  });
});
