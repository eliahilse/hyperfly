import { expect, test } from "bun:test";
import { z } from "zod";
import { CodecRegistry, compileIR, serializeArtifact, train, type IRNode } from "../src/index.js";
import { DecodeError, EncodeError, HyperflyError, isInstance, type ErrorCode } from "../src/errors.js";
import { decodeResponse, encodeFor, negotiate } from "../src/http.js";
import { compile } from "../src/zod.js";

const rows: IRNode = {
  kind: "array",
  element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
};

function revokingError(error: HyperflyError) {
  let codeReads = 0;
  const { proxy, revoke } = Proxy.revocable(error, {
    get(target, key, receiver) {
      if (key === "code") {
        codeReads++;
        revoke();
        // Reading the revoked receiver would leak a native TypeError from an unsafe code check.
        return Reflect.get(receiver, key);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { proxy, codeReads: () => codeReads };
}

const entries: [string, ErrorCode, (cause: HyperflyError) => unknown][] = [
  ["compileIR options prototype", "options", (cause) => compileIR(rows, new Proxy({}, { getPrototypeOf() { throw cause; } }))],
  ["compileIR limits keys", "options", (cause) => compileIR(rows, { limits: new Proxy({}, { ownKeys() { throw cause; } }) })],
  ["Zod compile options", "options", (cause) => compile(z.string(), new Proxy({}, { getPrototypeOf() { throw cause; } }))],
  ["train options prototype", "options", (cause) => train(rows, [], new Proxy({}, { getPrototypeOf() { throw cause; } }))],
  ["train options keys", "options", (cause) => train(rows, [], new Proxy({}, { ownKeys() { throw cause; } }))],
  ["compileIR profile", "ir", (cause) => compileIR(rows, {
    plan: "columnar", profile: { version: 1, shared: { columns: [] }, hints: { get value() { throw cause; } } },
  })],
  ["serializeArtifact profile", "ir", (cause) => serializeArtifact(rows, "columnar", {
    shared: { get columns(): never { throw cause; } },
  })],
  ["JSON encoding", "json", (cause) => encodeFor(negotiate(null, new CodecRegistry([compileIR(rows)])), {
    toJSON() { throw cause; },
  })],
  ["JSON decoding", "json", (cause) => decodeResponse("application/json", "[]", new CodecRegistry([{
    ...compileIR(rows), get ir(): never { throw cause; },
  }]))],
];

test.each(entries)("%s wraps a revoking error proxy with %s", (name, code, run) => {
  const ErrorClass = name === "JSON encoding" ? EncodeError : name === "JSON decoding" ? DecodeError : HyperflyError;
  const hostile = revokingError(new ErrorClass(code, "hostile"));
  let caught: unknown;
  try { run(hostile.proxy); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(HyperflyError);
  expect((caught as HyperflyError).code).toBe(code);
  expect((caught as HyperflyError).cause).toBe(hostile.proxy);
  expect(hostile.codeReads()).toBe(0);
});

test.each(["encode", "encodeBody", "decode", "decodeBody"] as const)("Zod %s wraps a revoking parse error", (method) => {
  const hostile = revokingError(new HyperflyError("validation", "hostile"));
  const schema = z.string();
  const codec = compile(schema, { validate: true });
  const plain = compileIR({ kind: "string" });
  schema.parse = () => { throw hostile.proxy; };
  let caught: unknown;
  try {
    if (method === "encode" || method === "encodeBody") codec[method]("value");
    else codec[method](method === "decode" ? plain.encode("value") : plain.encodeBody("value"));
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(method.startsWith("encode") ? EncodeError : DecodeError);
  expect((caught as HyperflyError).code).toBe("validation");
  expect((caught as HyperflyError).cause).toBe(hostile.proxy);
  expect(hostile.codeReads()).toBe(0);
});

test("caught Hyperfly error classification never inspects proxies or forged prototypes", () => {
  for (const ErrorClass of [HyperflyError, EncodeError, DecodeError]) {
    const original = new ErrorClass("json", "original");
    let prototypeReads = 0;
    const proxy = new Proxy(original, { getPrototypeOf() { prototypeReads++; throw new Error("must not inspect prototype"); } });
    expect(isInstance(original, ErrorClass)).toBe(true);
    expect(isInstance(proxy, ErrorClass)).toBe(false);
    expect(isInstance(Object.create(ErrorClass.prototype), ErrorClass)).toBe(false);
    expect(prototypeReads).toBe(0);
  }
});
