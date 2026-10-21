import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CodecRegistry, compileIR, type IRNode } from "../src/index.js";
import { decodeResponse, encodeFor, negotiate, readBody, respond } from "../src/http.js";

const url = "https://example.test/value";
const bytes = compileIR({ kind: "bytes" });
const text = compileIR({ kind: "string" });

async function decodeBoth(ir: IRNode, json: string, expected: unknown) {
  const registry = new CodecRegistry([compileIR(ir)]);
  expect(decodeResponse("application/json", json, registry)).toEqual({ kind: "json", value: expected });
  const request = new Request(url, { method: "POST", body: json });
  expect(await readBody(request, registry)).toEqual({ ok: true, value: expected });
}

test("JSON always uses the first codec, independently of the offer and codec header", async () => {
  for (const [codecs, expected] of [[ [bytes, text], new Uint8Array([0]) ], [ [text, bytes], "AA==" ]] as const) {
    const registry = new CodecRegistry(codecs);
    expect(decodeResponse("application/json", '"AA=="', registry)).toEqual({ kind: "json", value: expected });
    expect(await readBody(new Request(url, {
      method: "POST", body: '"AA=="', headers: { "Hyperfly-Codec": codecs[1].fingerprint },
    }), registry)).toEqual({ ok: true, value: expected });
  }
  const registry = new CodecRegistry([bytes, text]);
  for (const options of [{ offer: text.fingerprint }, { offer: "" }, { enabled: false }]) {
    expect(encodeFor(negotiate(null, registry, options), new Uint8Array([0])).body).toBe('"AA=="');
  }
  registry.remove(bytes.fingerprint);
  expect(decodeResponse("application/json", '"AA=="', registry)).toEqual({ kind: "json", value: "AA==" });
  registry.remove(text.fingerprint);
  expect(decodeResponse("application/json", '"AB=="', registry)).toEqual({ kind: "json", value: "AB==" });
});

test.each(["row", "columnar"] as const)("bytes survive JSON fallback after a %s encoder limit", async (plan) => {
  const codec = compileIR({ kind: "array", element: { kind: "bytes" } }, { plan, limits: { maxByteLength: 1 } });
  const registry = new CodecRegistry([codec]);
  const value = [new Uint8Array([0, 1])];
  const errors: string[] = [];
  const response = respond(new Request(url, { headers: { "Hyperfly-Accept": codec.fingerprint } }), value, registry, {
    onFallback: (error, reason) => errors.push(error.code, reason),
  });
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(await response.text()).toBe('["AAE="]');
  expect(errors).toEqual(["limit", "encoder-limit"]);
  await decodeBoth(codec.ir, '["AAE="]', value);
});

test("bytes fallback preserves JSON.stringify behavior elsewhere, including toJSON and repeated references", () => {
  const child: IRNode = { kind: "struct", fields: [{ name: "data", type: { kind: "bytes" } }] };
  const ir: IRNode = { kind: "struct", fields: [
    { name: "child", type: child }, { name: "number", type: { kind: "float64" } },
  ] };
  const shared = { data: new Uint8Array([0]), toJSON() { return { data: this.data, extra: "kept" }; } };
  const value = { child: shared, number: Infinity, omitted: undefined, extra: shared };
  const registry = new CodecRegistry([compileIR(ir)]);
  const encoded = encodeFor(negotiate(null, registry), value);
  expect(JSON.parse(encoded.body as string)).toEqual({
    child: { data: "AA==", extra: "kept" }, number: null, extra: { data: "AA==", extra: "kept" },
  });
  expect(encodeFor(negotiate(null, new CodecRegistry([bytes])), Buffer.from([255])).body).toBe('"/w=="');
});

test("non-bytes schemas validate, drop unknown fields and handle all field flags", async () => {
  const ir: IRNode = { kind: "struct", fields: [
    { name: "required", type: { kind: "int" } },
    { name: "optional", type: { kind: "bool" }, optional: true },
    { name: "nullable", type: { kind: "string" }, nullable: true },
  ] };
  await decodeBoth(ir, '{"required":3e0,"nullable":null,"ignored":{"data":"AB=="}}', { required: 3, nullable: null });
  await decodeBoth({ kind: "array", element: { kind: "bool" }, length: 1 }, "[true]", [true]);
});

test.each([
  [{ kind: "bool" }, "0"],
  [{ kind: "float64" }, "1e400"],
  [{ kind: "string" }, "1"],
  [{ kind: "literal", value: true }, "1"],
  [{ kind: "array", element: { kind: "bool" }, length: 1 }, "[]"],
  [{ kind: "struct", fields: [] }, "[]"],
  [{ kind: "nullable", inner: { kind: "int" } }, '"3"'],
] as [IRNode, string][])("conversion failures in %j are JSON failures in both directions", async (ir, body) => {
  const registry = new CodecRegistry([compileIR(ir)]);
  expect(() => decodeResponse("application/json", body, registry)).toThrow(expect.objectContaining({ code: "json" }));
  const result = await readBody(new Request(url, { method: "POST", body }), registry);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(400);
    expect(result.reason).toBe("malformed-json");
  }
});

test("JSON conversion handles the deepest supported IR", async () => {
  let ir: IRNode = { kind: "bytes" };
  let expected: unknown = new Uint8Array([0]);
  for (let i = 0; i < 510; i++) {
    ir = { kind: "array", element: ir };
    expected = [expected];
  }
  await decodeBoth(ir, `${"[".repeat(510)}"AA=="${"]".repeat(510)}`, expected);
});

test.each(["2", " \t2\t ", `${"0".repeat(5000)}2`, "9".repeat(5000)])("Content-Length rejects %j before acquiring a reader", async (length) => {
  let acquired = false;
  const body = new ReadableStream<Uint8Array>();
  body.getReader = () => { acquired = true; throw new Error("must not read"); };
  const request = {
    headers: { get: (name: string) => name === "content-type" ? "application/json" : length }, body,
  } as unknown as Request;
  const result = await readBody(request, new CodecRegistry(), { maxBytes: 1 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(413);
  expect(acquired).toBe(false);
});

test("JSON decisions encode bytes without a codec or decision identity at every position", () => {
  const registry = new CodecRegistry([text]);
  const decisions = [
    { ...negotiate(null, registry) },
    { kind: "json", headers: { "Content-Type": "application/json" }, reason: "disabled" } as const,
    negotiate(null, new CodecRegistry()),
  ];
  const foreign = runInNewContext("new Uint8Array([255])") as Uint8Array;
  const value = {
    nested: [new Uint8Array([255]), { buffer: Buffer.from([255]), foreign }],
    empty: new Uint8Array(),
    subarray: new Uint8Array([0, 255, 0]).subarray(1, 2),
  };
  for (const decision of decisions) {
    expect(JSON.parse(encodeFor(decision, value).body as string)).toEqual({
      nested: ["/w==", { buffer: "/w==", foreign: "/w==" }], empty: "", subarray: "/w==",
    });
  }
});

test.each([{ kind: "int" }, { kind: "literal", value: 0 }] satisfies IRNode[])("JSON -0 normalizes to 0 under %j", async (ir) => {
  await decodeBoth(ir, "-0", 0);
  const decoded = decodeResponse("application/json", "-0", new CodecRegistry([compileIR(ir)]));
  if (decoded.kind === "json") expect(Object.is(decoded.value, -0)).toBe(false);
  await decodeBoth({ kind: "struct", fields: [{ name: "values", type: { kind: "array", element: ir } }] },
    '{"values":[-0]}', { values: [0] });
});

test("JSON float64 keeps negative zero", async () => {
  await decodeBoth({ kind: "float64" }, "-0", -0);
});

test("JSON validation preserves parsed identities and copies only changed paths", () => {
  const ir: IRNode = { kind: "struct", fields: [
    { name: "rows", type: { kind: "array", element: { kind: "struct", fields: [
      { name: "id", type: { kind: "int" } },
      { name: "data", type: { kind: "bytes" }, optional: true },
    ] } } },
    { name: "unchanged", type: { kind: "struct", fields: [{ name: "active", type: { kind: "bool" } }] } },
  ] };
  const registry = new CodecRegistry([compileIR(ir)]);
  const parse = JSON.parse;
  const parsed = { rows: [{ id: 1 }], unchanged: { active: true } };
  const changed = { rows: [{ id: 1 }, { id: -0, data: "/w==", unknown: true }], unchanged: parsed.unchanged };
  try {
    JSON.parse = () => parsed;
    const same = decodeResponse("application/json", "{}", registry);
    expect(same.kind).toBe("json");
    if (same.kind === "json") expect(same.value).toBe(parsed);
    JSON.parse = () => changed;
    const decoded = decodeResponse("application/json", "{}", registry);
    expect(decoded.kind).toBe("json");
    if (decoded.kind === "json") {
      const result = decoded.value as { rows: { id: number; data?: unknown }[]; unchanged: { active: boolean } };
      expect(result).not.toBe(changed);
      expect(result.rows).not.toBe(changed.rows);
      expect(result.rows[0]).toBe(changed.rows[0]);
      expect(result.rows[1]).not.toBe(changed.rows[1]);
      expect(result.unchanged).toBe(changed.unchanged);
      expect(result.rows[1]).toEqual({ id: 0, data: new Uint8Array([255]) });
    }
    expect(changed.rows[1]).toEqual({ id: -0, data: "/w==", unknown: true });
  } finally {
    JSON.parse = parse;
  }
});

test("JSON conversion failures retain nested paths", () => {
  const registry = new CodecRegistry([compileIR({ kind: "struct", fields: [
    { name: "rows", type: { kind: "array", element: { kind: "struct", fields: [{ name: "data", type: { kind: "bytes" } }] } } },
  ] })]);
  expect(() => decodeResponse("application/json", '{"rows":[{"data":"AB=="}]}', registry))
    .toThrow(expect.objectContaining({ code: "json", message: "$.rows[0].data: expected canonical padded base64" }));
});

test.each([
  new ArrayBuffer(1), new SharedArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Int8Array([1]), new Uint8ClampedArray([1]),
  runInNewContext("new ArrayBuffer(1)") as ArrayBuffer,
  runInNewContext("new DataView(new ArrayBuffer(1))") as DataView,
  runInNewContext("new Uint16Array([1])") as Uint16Array,
])("JSON rejects unsupported byte storage and views with their path: %p", (value) => {
  const decision = negotiate(null, new CodecRegistry());
  expect(() => encodeFor(decision, { rows: [{ data: value }] }))
    .toThrow(expect.objectContaining({ code: "json", message: "$.rows[0].data: unsupported byte storage or view; use Uint8Array" }));
  expect(() => encodeFor(decision, value))
    .toThrow(expect.objectContaining({ code: "json", message: "$: unsupported byte storage or view; use Uint8Array" }));
});

test("JSON rejects shared storage beside bytes on the replacer path", () => {
  expect(() => encodeFor(negotiate(null, new CodecRegistry()), { s: new SharedArrayBuffer(2), b: new Uint8Array([255]) }))
    .toThrow(expect.objectContaining({ code: "json", message: "$.s: unsupported byte storage or view; use Uint8Array" }));
});

test("JSON preflight ignores inherited enumerable getters like JSON.stringify", () => {
  const prototype = Object.defineProperty({}, "ignored", { enumerable: true, get() { throw new Error("must not read"); } });
  const value: unknown = Object.assign(Object.create(prototype) as object, { id: 1 });
  expect(encodeFor(negotiate(null, new CodecRegistry()), value).body).toBe('{"id":1}');
});

test("JSON bytes conversion handles toJSON on byte subclasses and on surrounding values", () => {
  class Bytes extends Uint8Array {
    toJSON() { return "custom"; }
  }
  const value = { bytes: new Bytes([255]), nested: { toJSON: () => ({ data: new Uint8Array([255]) }) }, numeric: { 0: 255 } };
  expect(encodeFor(negotiate(null, new CodecRegistry()), value).body)
    .toBe('{"bytes":"/w==","nested":{"data":"/w=="},"numeric":{"0":255}}');
});

test.each([false, true])("conservative JSON getters run once in traversal order, bytes=%p", (withBytes) => {
  const calls: string[] = [];
  let reads = 0;
  const value = {
    ...(withBytes ? { bytes: new Uint8Array([255]) } : {}),
    get first() {
      calls.push("first");
      return ++reads === 1 ? { get nested() { calls.push("nested"); return 1; } } : "second read";
    },
    get last() { calls.push("last"); return 2; },
  };
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy(value as object, {})).body)
    .toBe(`${withBytes ? '{"bytes":"/w==",' : "{"}"first":{"nested":1},"last":2}`);
  expect(reads).toBe(1);
  expect(calls).toEqual(["first", "nested", "last"]);
});

test("JSON conversion reads getter results before their toJSON exactly once", () => {
  const calls: string[] = [];
  const value = {
    get data() {
      calls.push("get data");
      return { get toJSON() {
        calls.push("get toJSON");
        return function (this: object, key: string) {
          calls.push(`call toJSON ${key}`);
          expect(this).toBe(result);
          return new Uint8Array([255]);
        };
      } };
    },
  };
  const result = value.data;
  calls.length = 0;
  Object.defineProperty(value, "data", { enumerable: true, get() { calls.push("get data"); return result; } });
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy(value as object, {})).body).toBe('{"data":"/w=="}');
  expect(calls).toEqual(["get data", "get toJSON", "call toJSON data"]);
});

test("JSON observes a Proxy's Get-supplied toJSON without consulting has", () => {
  for (const nested of [false, true]) {
    const calls: string[] = [];
    const proxy = new Proxy({}, {
      has() { throw new Error("must not use HasProperty"); },
      get(_target, key) {
        calls.push(String(key));
        if (key === "toJSON") return function (this: object, key: string) {
          expect(this).toBe(proxy);
          calls.push(`call ${key}`);
          return new Uint8Array([255]);
        };
      },
    });
    expect(encodeFor(negotiate(null, new CodecRegistry()), nested ? { data: proxy } : proxy).body)
      .toBe(nested ? '{"data":"/w=="}' : '"/w=="');
    expect(calls).toEqual(["toJSON", `call ${nested ? "data" : ""}`]);
  }
});

test.each([
  new Uint8Array([255]), Buffer.from([255]), new ArrayBuffer(1), new SharedArrayBuffer(1), new DataView(new ArrayBuffer(1)),
  new Int8Array([1]), new Uint8ClampedArray([1]), new Uint16Array([1]), new Int16Array([1]),
  new Uint32Array([1]), new Int32Array([1]), new Float32Array([1]), new Float64Array([1]),
  new BigInt64Array([1n]), new BigUint64Array([1n]),
])("JSON rejects proxies around byte storage or views: %p", (target) => {
  const proxy = new Proxy(target, {});
  const decision = negotiate(null, new CodecRegistry());
  for (const [value, path] of [[proxy, "$"], [{ rows: [{ data: proxy }] }, "$.rows[0].data"]] as const) {
    expect(() => encodeFor(decision, value)).toThrow(expect.objectContaining({
      code: "json", message: `${path}: proxied byte storage or view; pass the Uint8Array itself`,
    }));
  }
});

test("JSON wraps revoked proxies at root, nested, behind getters and returned by toJSON", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  for (const value of [proxy, { rows: [proxy] }, { get value() { return proxy; } }, { toJSON: () => proxy }]) {
    expect(() => encodeFor(negotiate(null, new CodecRegistry()), value))
      .toThrow(expect.objectContaining({ name: "EncodeError", code: "json", cause: expect.any(TypeError) }));
  }
});

test.each([new ArrayBuffer(1), new SharedArrayBuffer(1)])("JSON rejects raw storage with a null prototype: %p", (buffer) => {
  Object.setPrototypeOf(buffer, null);
  const decision = negotiate(null, new CodecRegistry());
  expect(() => encodeFor(decision, buffer)).toThrow(expect.objectContaining({
    code: "json", message: "$: unsupported byte storage or view; use Uint8Array",
  }));
  expect(() => encodeFor(decision, { rows: [{ data: buffer }] })).toThrow(expect.objectContaining({
    code: "json", message: "$.rows[0].data: unsupported byte storage or view; use Uint8Array",
  }));
  const dictionary = Object.assign(Object.create(null) as object, { id: 1 });
  expect(encodeFor(decision, dictionary).body).toBe('{"id":1}');
});

test("JSON conversion preserves sparse arrays, inherited indices, key order and scalar representations", () => {
  const prototype = Object.create(Array.prototype) as unknown[];
  prototype[1] = new Uint8Array([255]);
  const sparse: unknown[] = new Array(4);
  sparse[0] = undefined;
  Object.setPrototypeOf(sparse, prototype);
  Object.defineProperty(sparse, "ignored", { enumerable: true, get() { throw new Error("must not read"); } });
  const value = Object.create({ inherited: "ignored" }) as Record<string, unknown>;
  for (const [key, item] of [["z", sparse], ["2", -0], ["1", NaN], ["__proto__", "own"], ["unicode", "\ud800\udfff\ud800\n\"\\"],
    ["undefined", undefined], ["function", () => {}], ["symbol", Symbol("x")], ["infinity", Infinity]] as const) {
    Object.defineProperty(value, key, { enumerable: true, value: item });
  }
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy(value as object, {})).body)
    .toBe('{"1":null,"2":0,"z":[null,"/w==",null,null],"__proto__":"own","unicode":' + JSON.stringify(value.unicode) + ',"infinity":null}');
});

test("JSON conversion wraps BigInt and cycles as TypeError causes before reading later getters", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const bad of [1n, Object(1n) as object, cycle]) {
    let later = 0;
    expect(() => encodeFor(negotiate(null, new CodecRegistry()), {
      bytes: new Uint8Array([255]), bad, get later() { later++; return 1; },
    })).toThrow(expect.objectContaining({ code: "json", cause: expect.any(TypeError) }));
    expect(later).toBe(0);
  }
});

test("JSON conversion matches JSON.stringify on 5,000 seeded graphs without bytes", () => {
  let seed = 0x51f15e;
  const random = (bound: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  const decision = negotiate(null, new CodecRegistry());
  for (let iteration = 0; iteration < 5000; iteration++) {
    const reads: number[] = [];
    const trace: string[] = [];
    const shared = { value: iteration };
    const scalar = (): unknown => [null, undefined, true, false, -0, NaN, Infinity, -Infinity,
      1.25, random(100_000), "", "\ud800", "\udfff", "é日本😀\n\t\"\\", Symbol("omitted"), () => {}][random(16)];
    function graph(depth: number): unknown {
      if (depth === 0) return scalar();
      switch (random(9)) {
        case 0: return scalar();
        case 1: return new Date(random(2) ? random(2_000_000_000) : NaN);
        case 2: return Object([true, -0, 3.75, "\ud800", Symbol("boxed")][random(5)]) as object;
        case 3: return { toJSON(key: string) { trace.push(`toJSON:${key}`); return { [key]: scalar() }; } };
        case 4: return [shared, shared, graph(depth - 1)];
        case 5: {
          const array: unknown[] = new Array(random(5));
          for (let i = 0; i < array.length; i++) if (random(3)) array[i] = graph(depth - 1);
          return array;
        }
        default: {
          const object = Object.create(random(2) ? null : { inherited: "ignored" }) as Record<string, unknown>;
          for (const key of ["2", "0", "__proto__", "odd.[]", "\ud800", "a"]) {
            if (random(3) === 0) continue;
            const value = graph(depth - 1);
            if (random(3) === 0) {
              const index = reads.push(0) - 1;
              Object.defineProperty(object, key, { enumerable: true, get() { reads[index]!++; trace.push(`get:${index}`); return value; } });
            } else Object.defineProperty(object, key, { enumerable: true, value });
          }
          return object;
        }
      }
    }
    // A root Proxy selects the conservative path; its accessor records the root Get.
    let rootReads = 0;
    const value = graph(3);
    const input = { get graph() { rootReads++; return value; } };
    const beforeSeed = seed;
    const expected = JSON.stringify(input);
    const expectedReads = [...reads];
    const expectedTrace = [...trace];
    seed = beforeSeed;
    rootReads = 0;
    reads.fill(0);
    trace.length = 0;
    expect(encodeFor(decision, new Proxy(input, {})).body).toBe(expected);
    expect(rootReads).toBe(1);
    expect(reads).toEqual(expectedReads);
    expect(reads.every((count) => count === 1)).toBe(true);
    expect(trace).toEqual(expectedTrace);
  }
});

test("JSON conversion preserves boxed primitive coercion, realms and toJSON results", () => {
  const number = Object(1) as { [Symbol.toPrimitive]?: () => number };
  number[Symbol.toPrimitive] = () => 12;
  const string = Object("original") as { toString?: () => string };
  string.toString = () => "changed\ud800";
  const boolean = Object(false) as { valueOf?: () => boolean };
  boolean.valueOf = () => true;
  const foreign: unknown = runInNewContext('[new Number(-0), new String("foreign"), new Boolean(false), Object(Symbol("x"))]');
  const returned = { toJSON: () => ({ toJSON: "not called", value: 1 }) };
  const functionValue = () => {};
  let calls = 0;
  Object.defineProperty(functionValue, "toJSON", { get() { calls++; return undefined; } });
  const value = { number, string, boolean, foreign, returned, functionValue };
  const expected = JSON.stringify(value);
  calls = 0;
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy(value as object, {})).body).toBe(expected);
  expect(calls).toBe(1);
});

test("JSON conversion reads inherited toJSON getters once and uses the root and array keys", () => {
  const calls: string[] = [];
  const prototype = Object.defineProperty({}, "toJSON", {
    get() { calls.push("get"); return function (key: string) { calls.push(`call:${key}`); return -0; }; },
  });
  const value: unknown = Object.create(prototype);
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy(value as object, {})).body).toBe("0");
  expect(calls).toEqual(["get", "call:"]);
  calls.length = 0;
  expect(encodeFor(negotiate(null, new CodecRegistry()), [value]).body).toBe("[0]");
  expect(calls).toEqual(["get", "call:0"]);
});

test("JSON preserves bytes returned by a getter even when their toJSON hides the view", () => {
  let reads = 0;
  let conversions = 0;
  class Bytes extends Uint8Array {
    toJSON() { conversions++; return "hidden"; }
  }
  expect(encodeFor(negotiate(null, new CodecRegistry()), new Proxy({
    get data() { reads++; return new Bytes([255]); },
  }, {})).body).toBe('{"data":"/w=="}');
  expect(reads).toBe(1);
  expect(conversions).toBe(1);
});

test.each([false, true])("ordinary JSON fallback retains accessor rereads, bytes=%p", (withBytes) => {
  let reads = 0;
  const value = {
    ...(withBytes ? { bytes: new Uint8Array([255]) } : {}),
    get data() { reads++; return withBytes ? new Uint8Array([reads]) : reads; },
  };
  expect(encodeFor(negotiate(null, new CodecRegistry()), value).body)
    .toBe(withBytes ? '{"bytes":"/w==","data":"Ag=="}' : '{"data":2}');
  expect(reads).toBe(2);
});

test("without runtime Proxy detection, native toJSON behavior and byte-proxy errors remain available", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule")!;
  try {
    Object.defineProperty(process, "getBuiltinModule", { ...descriptor, value: undefined });
    const path = "../src/http.ts?without-proxy-detection";
    const native = await import(path) as typeof import("../src/http.js");
    const decision = negotiate(null, new CodecRegistry());
    const proxy = new Proxy({}, { get: (_target, key) => key === "toJSON" ? () => new Uint8Array([255]) : undefined });
    expect(native.encodeFor(decision, proxy).body).toBe(JSON.stringify(proxy));
    expect(native.encodeFor(decision, { data: proxy }).body).toBe(JSON.stringify({ data: proxy }));
    for (const target of [new Uint8Array([255]), Buffer.from([255]), new ArrayBuffer(1), new SharedArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Int16Array([1])]) {
      const view = new Proxy(target, {});
      expect(() => native.encodeFor(decision, view)).toThrow(expect.objectContaining({
        code: "json", message: "$: proxied byte storage or view; pass the Uint8Array itself",
      }));
      expect(() => native.encodeFor(decision, { data: view })).toThrow(expect.objectContaining({
        code: "json", message: "$.data: proxied byte storage or view; pass the Uint8Array itself",
      }));
    }
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => native.encodeFor(decision, { data: revoked })).toThrow(expect.objectContaining({ name: "EncodeError", code: "json" }));
  } finally {
    Object.defineProperty(process, "getBuiltinModule", descriptor);
  }
});

test("JSON byte conversion ignores overridden typed-array properties", () => {
  class Bytes extends Uint8Array {
    get length() { return 0; }
    subarray() { return new Uint8Array([65, 65, 65]); }
  }
  for (const length of [3, 32, 0x8001]) {
    const expected = new Uint8Array(length).fill(1);
    expected.set([1, 2, 3]);
    const value = new Bytes(expected);
    for (const key of ["buffer", "byteOffset", "byteLength", "constructor", "toBase64", Symbol.iterator]) {
      Object.defineProperty(value, key, { get() { throw new Error(`must not read ${String(key)}`); } });
    }
    const decision = negotiate(null, new CodecRegistry());
    const body = JSON.stringify(Buffer.from(expected).toString("base64"));
    expect(encodeFor(decision, value).body).toBe(body);
    expect(encodeFor(decision, { data: value }).body).toBe(`{"data":${body as string}}`);
    expect(encodeFor(decision, new Proxy({ data: value }, {})).body).toBe(`{"data":${body as string}}`);
  }
});

test("JSON reports detached and out-of-bounds byte views with their path", () => {
  const detached = new Uint8Array([1, 2, 3]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
  const outOfBounds = new Uint8Array(buffer, 2, 2);
  buffer.resize(1);
  const decision = negotiate(null, new CodecRegistry());
  for (const bytes of [detached, outOfBounds]) {
    for (const [value, path] of [[bytes, "$"], [{ rows: [{ data: bytes }] }, "$.rows[0].data"],
      [new Proxy({ rows: [{ data: bytes }] }, {}), "$.rows[0].data"]] as const) {
      expect(() => encodeFor(decision, value)).toThrow(expect.objectContaining({
        name: "EncodeError", code: "json", message: `${path}: detached or out-of-bounds Uint8Array`, cause: expect.any(TypeError),
      }));
    }
  }
});

test("JSON base64 fallback reads slots when native toBase64 is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
  try {
    Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, value: undefined });
    const path = "../src/http.ts?without-native-base64";
    const fallback = await import(path) as typeof import("../src/http.js");
    const decision = negotiate(null, new CodecRegistry());
    for (const length of [3, 32, 0x8001]) {
      const bytes = new Uint8Array(length).fill(1);
      bytes.set([1, 2, 3]);
      const body = JSON.stringify(Buffer.from(bytes).toString("base64"));
      for (const key of ["length", "subarray", "buffer", "byteOffset", "byteLength", "constructor", "toBase64", Symbol.iterator]) {
        Object.defineProperty(bytes, key, { get() { throw new Error(`must not read ${String(key)}`); } });
      }
      expect(fallback.encodeFor(decision, bytes).body).toBe(body);
      expect(fallback.encodeFor(decision, new Proxy({ data: bytes }, {})).body).toBe(`{"data":${body}}`);
    }
    const detached = new Uint8Array([1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
    const outOfBounds = new Uint8Array(buffer, 2, 2);
    buffer.resize(1);
    for (const bytes of [detached, outOfBounds]) {
      expect(() => fallback.encodeFor(decision, { data: bytes })).toThrow(expect.objectContaining({
        code: "json", message: "$.data: detached or out-of-bounds Uint8Array", cause: expect.any(TypeError),
      }));
    }
  } finally {
    if (descriptor) Object.defineProperty(Uint8Array.prototype, "toBase64", descriptor);
    else Reflect.deleteProperty(Uint8Array.prototype, "toBase64");
  }
});
