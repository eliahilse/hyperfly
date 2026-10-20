import { describe, expect, test } from "bun:test";
import { compileIR, HyperflyError, train, type IRNode } from "../src/index.js";
import { MAX_DICT_ENTRIES } from "../src/profile.js";

const ROWS: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};

const samples = (values: string[][]) => values.map((vs) => vs.map((s) => ({ s })));

describe("reference trainer", () => {
  test("rejects samples that are not an array", () => {
    for (const bad of ["abc", 42, null, { length: 1, 0: [] }, new Set([[]])]) {
      const run = () => train(ROWS, bad as never);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options" }));
    }
  });

  test("keeps repeated values and drops one-offs", () => {
    const profile = train(ROWS, samples([["alpha", "alpha"], ["alpha", "beta"], ["beta", "unique"]]));
    expect(profile?.shared.columns).toEqual([{ leaf: 0, dict: ["alpha", "beta"] }]);
  });

  test("returns nothing when there is no repetition to exploit", () => {
    expect(train(ROWS, samples([["a"], ["b"], ["c"]]))).toBeUndefined();
  });

  test("orders by frequency so the shortest codes reach the most common values", () => {
    const profile = train(ROWS, samples([["rare", "rare", "common", "common", "common", "common"]]));
    expect(profile?.shared.columns[0]!.dict![0]).toBe("common");
  });

  test("a trained profile shrinks held-out data and round-trips", () => {
    const trainSet = samples([["online", "offline", "online"], ["online", "online", "degraded"]]);
    const profile = train(ROWS, trainSet);
    const bare = compileIR(ROWS, { plan: "columnar", pack: false });
    const profiled = compileIR(ROWS, { plan: "columnar", profile, pack: false });
    const holdout = [{ s: "online" }, { s: "offline" }, { s: "novel" }];
    expect(profiled.encodeBody(holdout).length).toBeLessThan(bare.encodeBody(holdout).length);
    expect(profiled.decodeBody(profiled.encodeBody(holdout))).toEqual(holdout);
  });

  test("output always compiles, including at the entry ceiling", () => {
    const many = Array.from({ length: MAX_DICT_ENTRIES + 50 }, (_, i) => `v${i}`);
    const profile = train(ROWS, samples([many, many]));
    expect(profile!.shared.columns[0]!.dict!.length).toBeLessThanOrEqual(MAX_DICT_ENTRIES);
    expect(() => compileIR(ROWS, { plan: "columnar", profile })).not.toThrow();
  });

  test("nested and multi-array schemas train to the right ordinals", () => {
    const ir: IRNode = {
      kind: "struct",
      fields: [
        { name: "a", type: ROWS },
        {
          name: "b",
          type: {
            kind: "array",
            element: {
              kind: "struct",
              fields: [{ name: "inner", type: { kind: "struct", fields: [{ name: "t", type: { kind: "string" } }] } }],
            },
          },
        },
      ],
    };
    const sample = { a: [{ s: "aa" }, { s: "aa" }], b: [{ inner: { t: "bb" } }, { inner: { t: "bb" } }] };
    const profile = train(ir, [sample, sample]);
    expect(profile?.shared.columns).toEqual([
      { leaf: 0, dict: ["aa"] },
      { leaf: 1, dict: ["bb"] },
    ]);
    const codec = compileIR(ir, { plan: "columnar", profile, pack: false });
    expect(codec.decodeBody(codec.encodeBody(sample))).toEqual(sample);
  });

  test("never proposes an entry the codec would refuse", () => {
    const profile = train(ROWS, samples([["\ud800x", "\ud800x"], ["ok", "ok"]]));
    expect(profile?.shared.columns[0]!.dict).toEqual(["ok"]);
  });
});

describe("train options", () => {
  test.each([null, false, true, 0, "options", [], () => {}, new Date(), new (class Options {})(), Object.create({})].map((value) => [value] as const))(
    "rejects non-plain options %p", (options) => {
      const run = () => train(ROWS, [], options as never);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options", message: "options: must be an object" }));
    },
  );

  for (const key of ["minOccurrences", "maxEntries"] as const) {
    test.each([1.5, -1, NaN, Infinity, -Infinity, "2", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1].map((value) => [value] as const))(
      `rejects invalid ${key} %p`, (value) => {
        const run = () => train(ROWS, [], { [key]: value } as never);
        expect(run).toThrow(HyperflyError);
        expect(run).toThrow(expect.objectContaining({ code: "options", message: expect.stringContaining(`${key}:`) }));
      },
    );
  }

  test.each([
    [{ minOccurrences: 0 }, "minOccurrences: must be a safe integer >= 1"],
    [{ maxEntries: MAX_DICT_ENTRIES + 1 }, "maxEntries: must be a safe integer in [0, 16383]"],
  ] as const)("rejects out-of-bounds options %p", (options, message) => {
    const run = () => train(ROWS, [], options);
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "options", message }));
  });

  test.each([
    [{ unknown: 1 }, "unknown"],
    [{ unknown: undefined }, "unknown"],
    [Object.defineProperty({}, "hidden", { value: 1 }), "hidden"],
    [{ [Symbol("option")]: 1 }, "Symbol(option)"],
    [JSON.parse('{"__proto__":0}'), "__proto__"],
  ] as [unknown, string][])("rejects unknown options %p", (options, key) => {
    const run = () => train(ROWS, [], options as never);
    expect(run).toThrow(HyperflyError);
    expect(run).toThrow(expect.objectContaining({ code: "options", message: `options.${key}: unknown option` }));
  });

  test.each(["minOccurrences", "maxEntries"] as const)("wraps a throwing %s getter", (key) => {
    for (const cause of [new TypeError("cannot read option"), new HyperflyError("options", "getter failed")]) {
      const options = Object.defineProperty({}, key, { get() { throw cause; } });
      const run = () => train(ROWS, [], options);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options", message: expect.stringContaining(key), cause }));
    }
  });

  test("reads each option once and trains with the validated values", () => {
    const reads = { minOccurrences: 0, maxEntries: 0 };
    const profile = train(ROWS, samples([["a long unique value"]]), {
      get minOccurrences() { return ++reads.minOccurrences === 1 ? 1 : NaN; },
      get maxEntries() { return ++reads.maxEntries === 1 ? 1 : NaN; },
    });
    expect(reads).toEqual({ minOccurrences: 1, maxEntries: 1 });
    expect(profile?.shared.columns).toEqual([{ leaf: 0, dict: ["a long unique value"] }]);
  });

  test("undefined fields and plain options preserve defaults", () => {
    const data = samples([["alpha", "alpha", "alpha"]]);
    const expected = train(ROWS, data);
    for (const options of [undefined, {}, { minOccurrences: undefined, maxEntries: undefined }, Object.create(null)]) {
      expect(train(ROWS, data, options)).toEqual(expected);
    }
  });

  test("accepts minOccurrences at the safe integer boundaries", () => {
    const data = samples([["a long unique value"]]);
    expect(train(ROWS, data, { minOccurrences: 1 })?.shared.columns).toEqual([
      { leaf: 0, dict: ["a long unique value"] },
    ]);
    expect(train(ROWS, data, { minOccurrences: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  });

  test("accepts maxEntries at zero and the dictionary ceiling", () => {
    const data = samples([["alpha", "alpha", "alpha"]]);
    expect(train(ROWS, data, { maxEntries: 0 })).toBeUndefined();
    expect(train(ROWS, data, { maxEntries: MAX_DICT_ENTRIES })).toEqual(train(ROWS, data));
  });
});

describe("trainer grammar induction", () => {
  test("induces through an all-letter hex segment", () => {
    const profile = train(
      ROWS,
      samples([
        ["id_00af", "id_beef"],
        ["id_cafe", "id_12ff"],
      ]),
    );
    expect(profile?.shared.columns[0]?.grammar).toEqual([
      { lit: "id_" },
      { num: { base: 16, len: 4, case: "lower" } },
    ]);
    const codec = compileIR(ROWS, { plan: "columnar", profile, pack: false });
    const holdout = [{ s: "id_0123" }, { s: "id_dead" }, { s: "id_zzzz" }];
    expect(codec.decodeBody(codec.encodeBody(holdout))).toEqual(holdout);
  });

  test("mixed case within a slot yields no grammar", () => {
    const profile = train(
      ROWS,
      samples([
        ["id_00AF", "id_00af"],
        ["id_12Ff", "id_34aa"],
      ]),
    );
    expect(profile?.shared.columns[0]?.grammar).toBeUndefined();
  });

  test("a constant slot becomes a literal, not a lane", () => {
    const profile = train(
      ROWS,
      samples([
        ["v2-0001-x", "v2-0002-x"],
        ["v2-0003-x", "v2-0004-x"],
      ]),
    );
    expect(profile?.shared.columns[0]?.grammar).toEqual([
      { lit: "v2-" },
      { num: { base: 10, len: 4, case: "lower" } },
      { lit: "-x" },
    ]);
  });
});

describe("trainer derivations", () => {
  const PAIR: IRNode = {
    kind: "array",
    element: {
      kind: "struct",
      fields: [
        { name: "a", type: { kind: "string" } },
        { name: "b", type: { kind: "string" }, optional: true },
      ],
    },
  };

  test("emits the mapping when every source entry has an observed target", () => {
    const rows = [
      [{ a: "u1", b: "kim@x.io" }, { a: "u2", b: "lee@x.io" }],
      [{ a: "u1", b: "kim@x.io" }, { a: "u2", b: "lee@x.io" }],
    ];
    const profile = train(PAIR, rows);
    const column = profile?.shared.columns.find((c) => c.derived);
    expect(column?.derived?.source).toBe(0);
    expect(column?.derived?.values).toEqual(["kim@x.io", "lee@x.io"]);
    const codec = compileIR(PAIR, { plan: "columnar", profile, pack: false });
    expect(codec.decodeBody(codec.encodeBody(rows[0]!))).toEqual(rows[0]!);
  });

  test("an unobserved source entry blocks the derivation", () => {
    const rows = [
      [{ a: "u1", b: "kim@x.io" }, { a: "u2" }],
      [{ a: "u1", b: "kim@x.io" }, { a: "u2" }],
    ];
    const profile = train(PAIR, rows);
    for (const column of profile?.shared.columns ?? []) {
      expect(column.derived).toBeUndefined();
    }
  });

  test("a contradicted mapping blocks the derivation", () => {
    const rows = [
      [{ a: "u1", b: "kim@x.io" }, { a: "u1", b: "other@x.io" }],
      [{ a: "u1", b: "kim@x.io" }, { a: "u1", b: "kim@x.io" }],
    ];
    const profile = train(PAIR, rows);
    for (const column of profile?.shared.columns ?? []) {
      expect(column.derived).toBeUndefined();
    }
  });
});
