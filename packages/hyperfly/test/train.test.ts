import { describe, expect, test } from "bun:test";
import { compileIR, train, MAX_DICT_ENTRIES, type IRNode } from "../src/index.js";

const ROWS: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};

const samples = (values: string[][]) => values.map((vs) => vs.map((s) => ({ s })));

describe("reference trainer", () => {
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
