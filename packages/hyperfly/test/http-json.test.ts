import { expect, test } from "bun:test";
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
    child: { data: "AA==", extra: "kept" }, number: null, extra: { data: { 0: 0 }, extra: "kept" },
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
