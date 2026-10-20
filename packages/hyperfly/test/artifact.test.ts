import { describe, expect, test } from "bun:test";
import vectors from "../../../spec/vectors/fingerprints.json" with { type: "json" };
import { fingerprintOf, toHex } from "../src/canonical.js";
import { CodecRegistry, compileIR, FingerprintMismatchError, HyperflyError, train, type IRNode } from "../src/index.js";
import { DEFAULT_MAX_BODY_BYTES, discovery, fetchArtifact, loadArtifact } from "../src/http.js";

const ROWS: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};
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
const dictRows = [[{ s: "online" }, { s: "offline" }, { s: "online" }], [{ s: "online" }, { s: "online" }, { s: "degraded" }]];
const grammarRows = [[{ s: "id_00af" }, { s: "id_beef" }], [{ s: "id_cafe" }, { s: "id_12ff" }]];
const derivedRows = [{ a: "u1", b: "kim@x.io" }, { a: "u2", b: "lee@x.io" }];
const dict = train(ROWS, dictRows)!;
const grammar = train(ROWS, grammarRows)!;
const derived = train(PAIR, [derivedRows, derivedRows])!;
const codec = compileIR(ROWS);
const sample = [{ s: "é" }, { s: "hello" }];
const cases = [
  { name: "row", codec, sample },
  { name: "columnar", codec: compileIR(ROWS, { plan: "columnar" }), sample },
  { name: "profiled v1", codec: compileIR(ROWS, { plan: "columnar", profile: dict }), sample: dictRows[0]! },
  { name: "profiled v2 grammar", codec: compileIR(ROWS, { plan: "columnar", profile: grammar }), sample: grammarRows[0]! },
  { name: "profiled v2 derived", codec: compileIR(PAIR, { plan: "columnar", profile: derived }), sample: derivedRows },
];

describe("loadArtifact", () => {
  test("fixtures exercise both profile versions", () => {
    expect(dict.version).toBe(1);
    expect(grammar.version).toBe(2);
    expect(grammar.shared.columns.some((column) => column.grammar)).toBe(true);
    expect(derived.version).toBe(2);
    expect(derived.shared.columns.some((column) => column.derived)).toBe(true);
  });

  test("reports throwing option getters as options errors", () => {
    const codec = compileIR(ROWS);
    const cause = new TypeError("cannot read option");
    for (const options of [
      { get limits(): never { throw cause; } },
      { get pack(): never { throw cause; } },
    ]) {
      const run = () => loadArtifact(codec.artifact, codec.fingerprint, options);
      expect(run).toThrow(HyperflyError);
      expect(run).toThrow(expect.objectContaining({ code: "options", cause }));
    }
  });

  test.each(cases)("rebuilds $name with identical bytes", ({ codec, sample }) => {
    const loaded = loadArtifact(codec.artifact, codec.fingerprint);
    expect(loaded.fingerprint).toBe(codec.fingerprint);
    expect(loaded.decode(codec.encode(sample))).toEqual(sample);
    expect(loaded.encode(sample)).toEqual(codec.encode(sample));
  });

  test.each(vectors.cases)("loads fingerprint vector $name", ({ canonical, fingerprint }) => {
    expect(loadArtifact(canonical, fingerprint).fingerprint).toBe(fingerprint);
  });

  test.each(cases)("derives $name from content despite whitespace and key order", ({ codec }) => {
    const parsed = JSON.parse(codec.artifact);
    const text = JSON.stringify({ ir: parsed.ir, plan: parsed.plan, wire: parsed.wire, ...(parsed.profile ? { profile: parsed.profile } : {}) }, null, 2);
    expect(loadArtifact(text, codec.fingerprint).artifact).toBe(codec.artifact);
  });

  test("accepts an uppercase fingerprint", () => {
    expect(loadArtifact(codec.artifact, codec.fingerprint.toUpperCase()).fingerprint).toBe(codec.fingerprint);
  });

  test("rejects non-JSON with a json error", () => {
    expect(() => loadArtifact("{", codec.fingerprint)).toThrow(HyperflyError);
    expect(() => loadArtifact("{", codec.fingerprint)).toThrow(expect.objectContaining({ code: "json", message: expect.stringContaining("artifact is not JSON"), cause: expect.any(SyntaxError) }));
  });

  test.each([
    { name: "null root", value: null, path: "$" },
    { name: "array root", value: [], path: "$" },
    { name: "primitive root", value: 1, path: "$" },
    { name: "extra root key", value: { ...JSON.parse(codec.artifact), extra: true }, path: "$" },
    { name: "missing ir", value: { wire: 1, plan: { layout: "row", version: 1 } }, path: "$" },
    { name: "wire 2", value: { ...JSON.parse(codec.artifact), wire: 2 }, path: "$.wire" },
    { name: "missing plan", value: { wire: 1, ir: ROWS }, path: "$" },
    { name: "null plan", value: { wire: 1, plan: null, ir: ROWS }, path: "$.plan" },
    { name: "array plan", value: { wire: 1, plan: [], ir: ROWS }, path: "$.plan" },
    { name: "extra plan key", value: { wire: 1, plan: { layout: "row", version: 1, extra: true }, ir: ROWS }, path: "$.plan" },
    { name: "unknown layout", value: { wire: 1, plan: { layout: "unknown", version: 1 }, ir: ROWS }, path: "$.plan.layout" },
    { name: "missing layout", value: { wire: 1, plan: { version: 1 }, ir: ROWS }, path: "$.plan" },
    { name: "missing version", value: { wire: 1, plan: { layout: "row" }, ir: ROWS }, path: "$.plan" },
    { name: "non-number version", value: { wire: 1, plan: { layout: "row", version: "1" }, ir: ROWS }, path: "$.plan.version" },
  ])("rejects $name", ({ value, path }) => {
    expect(() => loadArtifact(JSON.stringify(value), codec.fingerprint)).toThrow(expect.objectContaining({
      code: "ir", message: expect.stringContaining(`${path}:`),
    }));
  });

  test.each([null, false, [], {}, { columns: null }, { columns: [null] }, { columns: [{ leaf: 0, grammar: null }] }].map((profile) => ({ profile })))(
    "validates malformed profile $profile through compileIR",
    ({ profile }) => {
      const text = JSON.stringify({ wire: 1, plan: { layout: "columnar", version: 5 }, ir: ROWS, profile });
      expect(() => loadArtifact(text, codec.fingerprint)).toThrow(expect.objectContaining({ code: "ir" }));
    },
  );

  test("rejects a plan version this build does not speak", () => {
    const text = codec.artifact.replace('"version":1', '"version":99');
    const versionError = expect.objectContaining({ code: "ir", message: expect.stringContaining("$.plan.version:") });
    expect(() => loadArtifact(text, toHex(fingerprintOf(text)))).toThrow(versionError);
    expect(() => loadArtifact(text, codec.fingerprint)).toThrow(versionError);
  });

  test.each([
    null,
    1,
    { kind: "nullable" },
    { kind: "struct" },
    { kind: "struct", fields: [null] },
    { kind: "enum" },
    { kind: "enum", members: "ab" },
    { kind: "enum", members: 123 },
    { kind: "array", element: null },
  ].map((ir) => ({ ir })))("codes a compile failure for IR $ir", ({ ir }) => {
    const text = JSON.stringify({ wire: 1, plan: { layout: "row", version: 1 }, ir });
    expect(() => loadArtifact(text, codec.fingerprint)).toThrow(HyperflyError);
  });

  test("rejects deep nesting before compiling", () => {
    const depth = 40_000;
    const text = `{"wire":1,"plan":{"layout":"row","version":1},"ir":${'{"kind":"array","element":'.repeat(depth)}{"kind":"bool"}${"}".repeat(depth)}}`;
    expect(() => loadArtifact(text, codec.fingerprint)).toThrow(expect.objectContaining({ code: "ir", message: expect.stringContaining("nests deeper") }));
  });

  test("rejects renamed fields rather than trusting the offered fingerprint", () => {
    const text = codec.artifact.replace('"name":"s"', '"name":"t"');
    const actual = compileIR({ kind: "array", element: { kind: "struct", fields: [{ name: "t", type: { kind: "string" } }] } }).fingerprint;
    expect(() => loadArtifact(text, codec.fingerprint)).toThrow(FingerprintMismatchError);
    expect(() => loadArtifact(text, codec.fingerprint)).toThrow(expect.objectContaining({ expected: codec.fingerprint, actual }));
  });

  test.each(["", "a".repeat(31), "a".repeat(33), "g".repeat(32), "../artifact", `${codec.fingerprint}\n`])(
    "rejects malformed fingerprint %j before parsing",
    (fingerprint) => {
      expect(() => loadArtifact("not JSON", fingerprint)).toThrow(expect.objectContaining({ code: "fingerprint" }));
    },
  );

  test("forwards decode limits and pack hooks", () => {
    const limited = loadArtifact(codec.artifact, codec.fingerprint, { limits: { maxItems: 1 }, pack: false });
    expect(() => limited.decode(codec.encode(sample))).toThrow(expect.objectContaining({ code: "limit" }));
    const columnar = compileIR(ROWS, { plan: "columnar", pack: false });
    let deflated = false;
    const loaded = loadArtifact(columnar.artifact, columnar.fingerprint, {
      pack: { deflate: (bytes) => { deflated = true; return bytes; }, inflate: (bytes) => bytes },
    });
    loaded.encode(Array.from({ length: 200 }, (_, i) => ({ s: `id_${i}` })));
    expect(deflated).toBe(true);
  });
});

describe("fetchArtifact", () => {
  const base = "https://api.example/v1/";
  const registry = new CodecRegistry(cases.map(({ codec }) => codec as never));
  const routed = (async (input, init) => discovery(new Request(input, init), registry)!) as typeof fetch;
  const returning = (response: Response) => (async () => response) as unknown as typeof fetch;

  test.each(cases)("discovers $name", async ({ codec, sample }) => {
    const loaded = await fetchArtifact(base, codec.fingerprint, { fetch: routed });
    expect(loaded?.fingerprint).toBe(codec.fingerprint);
    expect(loaded?.decode(codec.encode(sample))).toEqual(sample);
    expect(loaded?.encode(sample)).toEqual(codec.encode(sample));
  });

  test("returns undefined for a discovery miss", async () => {
    expect(await fetchArtifact(base, "f".repeat(32), { fetch: routed })).toBeUndefined();
  });

  test("uses an absolute well-known path, GET, a lowercase fingerprint and the caller's signal", async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const fetch = (async (input, init) => {
      calls++;
      expect(String(input)).toBe(`https://api.example/.well-known/hyperfly/${codec.fingerprint}`);
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBe(signal);
      return discovery(new Request(input, init), registry)!;
    }) as typeof globalThis.fetch;
    expect((await fetchArtifact(new URL(base), codec.fingerprint.toUpperCase(), { fetch, signal }))?.fingerprint).toBe(codec.fingerprint);
    expect(calls).toBe(1);
  });

  test.each([301, 403, 500])("rejects HTTP status %s", async (status) => {
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(null, { status })) }))
      .rejects.toThrow(expect.objectContaining({ code: "fingerprint", message: `artifact fetch failed with status ${status}` }));
  });

  test.each(["../artifact", "g".repeat(32), `${codec.fingerprint}\n`])("rejects fingerprint %j before fetching", async (fingerprint) => {
    let called = false;
    const fetch = (async () => { called = true; return new Response(); }) as unknown as typeof globalThis.fetch;
    await expect(fetchArtifact(base, fingerprint, { fetch })).rejects.toThrow(expect.objectContaining({ code: "fingerprint" }));
    expect(called).toBe(false);
  });

  test.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "1024", true])("rejects maxBytes %p before fetching", async (maxBytes) => {
    let called = false;
    const fetch = (async () => { called = true; return new Response(); }) as unknown as typeof globalThis.fetch;
    const run = fetchArtifact(base, codec.fingerprint, { fetch, maxBytes: maxBytes as never });
    await expect(run).rejects.toBeInstanceOf(HyperflyError);
    await expect(run).rejects.toThrow(expect.objectContaining({ code: "options" }));
    expect(called).toBe(false);
  });

  test.each([undefined, 0, 5])("enforces the streamed byte cap %s", async (maxBytes) => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(maxBytes === undefined ? DEFAULT_MAX_BODY_BYTES + 1 : 3)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(body)), maxBytes }))
      .rejects.toThrow(expect.objectContaining({ code: "limit" }));
    expect(cancelled).toBe(true);
    expect(pulls).toBe(maxBytes === 5 ? 2 : 1);
    expect(body.locked).toBe(false);
  }, 500);

  test("accepts exactly maxBytes across chunks, counting UTF-8 bytes and skipping empty chunks", async () => {
    const unicode = compileIR({ kind: "literal", value: "é" });
    const bytes = new TextEncoder().encode(unicode.artifact);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0));
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const loaded = await fetchArtifact(base, unicode.fingerprint, { fetch: returning(new Response(body)), maxBytes: bytes.byteLength });
    expect(loaded?.fingerprint).toBe(unicode.fingerprint);
  });

  test("copies each chunk before the stream reuses its buffer", async () => {
    const bytes = new TextEncoder().encode(codec.artifact);
    const buffer = new Uint8Array(1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        buffer[0] = bytes[offset++]!;
        controller.enqueue(buffer);
      },
    }, { highWaterMark: 0 });
    const loaded = await fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(body)) });
    expect(loaded?.fingerprint).toBe(codec.fingerprint);
  });

  test("rejects invalid UTF-8", async () => {
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(new Uint8Array([0xff]))) }))
      .rejects.toThrow(expect.objectContaining({ code: "ir", message: expect.stringContaining("UTF-8") }));
  });

  test("rejects stream read failures and releases the reader", async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("aborted"); } }, { highWaterMark: 0 });
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(body)) }))
      .rejects.toThrow(expect.objectContaining({ code: "ir" }));
    expect(body.locked).toBe(false);
  });

  test("rejects a locked response body as unreadable", async () => {
    const response = new Response(codec.artifact);
    response.body!.getReader();
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(response) }))
      .rejects.toThrow(expect.objectContaining({ code: "ir", message: "artifact body could not be read" }));
  });

  test("forwards request headers", async () => {
    const seen: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return routed(input, init);
    }) as typeof fetch;
    await fetchArtifact(base, codec.fingerprint, { fetch: fetchStub, headers: { Authorization: "Bearer t" } });
    expect(seen).toEqual(["Bearer t"]);
  });

  test("propagates an abort during the body read", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        controller.abort(new Error("stop"));
        throw new Error("stream aborted");
      },
    }, { highWaterMark: 0 });
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(body)), signal: controller.signal }))
      .rejects.toThrow("stop");
  });

  test("rejects an empty body", async () => {
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(null)) }))
      .rejects.toThrow(expect.objectContaining({ code: "json", cause: expect.any(SyntaxError) }));
  });

  test("verifies the fetched artifact and forwards codec options", async () => {
    await expect(fetchArtifact(base, codec.fingerprint, { fetch: returning(new Response(codec.artifact.replace('"name":"s"', '"name":"t"'))) }))
      .rejects.toThrow(FingerprintMismatchError);
    const loaded = await fetchArtifact(base, codec.fingerprint, { fetch: routed, limits: { maxItems: 1 }, pack: false });
    expect(() => loaded!.decode(codec.encode(sample))).toThrow(expect.objectContaining({ code: "limit" }));
  });
});
