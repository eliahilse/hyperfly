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
