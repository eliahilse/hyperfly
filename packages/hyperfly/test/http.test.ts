import { describe, expect, test } from "bun:test";
import acceptVectors from "../../../spec/vectors/accept.json" with { type: "json" };
import { z } from "zod";
import { CodecRegistry, type IRNode } from "../src/index.js";
import { compileIR } from "../src/index.js";
import { HEADER_SIZE, WIRE_VERSION } from "../src/codec.js";
import { DecodeError, EncodeError, HyperflyError } from "../src/errors.js";
import {
  ACCEPT_HEADER,
  HYPERFLY_MEDIA_TYPE,
  DEFAULT_MAX_BODY_BYTES,
  acceptHeader,
  decodeResponse,
  encodeFor,
  loadArtifact,
  negotiate,
  parseAccept,
  serveArtifact,
  respond,
  discovery,
  readBody,
} from "../src/http.js";
import { compile } from "../src/zod.js";

const Schema = z.object({ id: z.string(), n: z.number().int().min(0) });
const codecA = compile(Schema);
const codecB = compile(Schema, { plan: "columnar" });
const value = { id: "abc", n: 7 };

describe("parseAccept", () => {
  test.each(acceptVectors)("$name", ({ header, expected }) => {
    expect(parseAccept(header)).toEqual(expected);
  });

  test("absent or empty header yields nothing", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept(undefined)).toEqual([]);
    expect(parseAccept("")).toEqual([]);
  });

  test("a hostile header is bounded, not fatal", () => {
    const flood = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(32, "0")).join(",");
    expect(parseAccept(flood).length).toBeLessThanOrEqual(32);
    expect(parseAccept(",".repeat(1024 * 1024))).toEqual([]);
  });
});

describe("negotiate", () => {
  const registry = new CodecRegistry([codecA as never]);

  test("serves binary when the client holds the codec", () => {
    const decision = negotiate(acceptHeader([codecA.fingerprint]), registry);
    expect(decision.kind).toBe("hyperfly");
    expect(decision.headers["Content-Type"]).toBe(HYPERFLY_MEDIA_TYPE);
    expect(decision.headers["Hyperfly-Codec"]).toBe(codecA.fingerprint);
  });

  test("falls back to JSON and offers an upgrade when nothing matches", () => {
    const decision = negotiate(acceptHeader(["f".repeat(32)]), registry);
    expect(decision.kind).toBe("json");
    expect(decision.headers["Hyperfly-Offer"]).toBe(codecA.fingerprint);
  });

  test("a client that says nothing gets JSON", () => {
    expect(negotiate(undefined, registry).kind).toBe("json");
  });

  test.each([
    "application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;q=0.",
    "application/vnd.hyperfly;q=0.0",
    "application/vnd.hyperfly;q=0.00",
    "APPLICATION/VND.HYPERFLY ; Q=0.000",
    "application/*;q=0",
    "*/*;q=0",
    "application/json, \tapplication/vnd.hyperfly\t;\tq \t=\t0\t",
    "application/vnd.hyperfly;q=0, application/vnd.hyperfly;q=1",
    "application/*;q=0, */*;q=1",
    "*/*;q=1, application/*;q=0",
    "*/*;q=0, application/vnd.hyperfly;q=abc",
    "*/*;q=0, application/vnd.hyperfly;q=1.001",
    "*/*;q=0, application/vnd.hyperfly;q=0\n",
    "*/*;q=0, application/vnd.hyperfly;version=2;q=1",
  ])("opts out with %s", (accept) => {
    expect(negotiate(codecA.fingerprint, registry, { accept })).toEqual({
      kind: "json",
      headers: {
        Vary: "Hyperfly-Accept, Accept",
        "Content-Type": "application/json",
        "Hyperfly-Offer": codecA.fingerprint,
      },
    });
  });

  test.each([
    "application/vnd.hyperfly;q=0.001",
    "application/vnd.hyperfly-x;q=0",
    "*/*;q=0, application/vnd.hyperfly",
    "application/*;q=0, application/vnd.hyperfly;q=0.5",
    "application/vnd.hyperfly, */*;q=0",
    "application/vnd.hyperfly;q=1, application/vnd.hyperfly;q=0",
    "application/vnd.hyperfly;version=2;q=0",
    "application/vnd.hyperfly; version=1; q=0; charset=x",
    "application/vnd.hyperfly",
    "application/vnd.hyperfly;q=1.",
    "application/vnd.hyperfly;q=1.000",
    "application/json",
    "application/vnd.hyperfly;q=abc",
    "application/vnd.hyperfly;q=0.0000",
    "application/vnd.hyperfly;q=0x",
    "application/vnd.hyperfly;q=1.001, */*;q=0.1",
    "application/vnd.hyperfly;q=2",
    "application/vnd.hyperfly;q=.0",
    "application/vnd.hyperfly;q=0;invalid",
    "application/vnd.hyperfly;q=0;",
    'application/vnd.hyperfly;q="0"',
    'application/vnd.hyperfly; version="x;q=0"',
    "application/vnd.hyperfly;q=0\n",
    `${Array.from({ length: 32 }, () => "invalid").join(",")},application/vnd.hyperfly;q=0`,
    `${",".repeat(32)}application/vnd.hyperfly;q=0`,
    null,
    undefined,
  ])("does not opt out with %s", (accept) => {
    expect(negotiate(codecA.fingerprint, registry, { accept }).kind).toBe("hyperfly");
  });

  test("examines at most 32 media ranges, including malformed entries", () => {
    const prefix = Array.from({ length: 31 }, () => "invalid").join(",");
    expect(negotiate(codecA.fingerprint, registry, {
      accept: `${prefix},application/vnd.hyperfly;q=0`,
    }).kind).toBe("json");
    expect(negotiate(codecA.fingerprint, registry, {
      accept: `${prefix},invalid,application/vnd.hyperfly;q=0`,
    }).kind).toBe("hyperfly");
    expect(negotiate(codecA.fingerprint, registry, {
      accept: `${",".repeat(31)}application/vnd.hyperfly;q=0`,
    }).kind).toBe("json");
  });

  test.each([
    ['*/*;q=0,application/vnd.hyperfly;foo="x,application/vnd.hyperfly;q=1,y"', "json"],
    ['text/html;foo="x,application/vnd.hyperfly;q=0,y"', "hyperfly"],
    ["application/vnd.hyperfly;q=0;q=1", "hyperfly"],
    ["application/vnd.hyperfly;q=1;q=0", "hyperfly"],
    ['text/html;foo="x\\",application/vnd.hyperfly;q=0,y"', "hyperfly"],
    ['text/html;foo="x\\\\",application/vnd.hyperfly;q=0', "json"],
    ['text/html;foo="x,application/vnd.hyperfly;q=0', "hyperfly"],
    [`${'text/html;foo="x,y",'.repeat(31)}application/vnd.hyperfly;q=0`, "json"],
    [`${'text/html;foo="x,y",'.repeat(32)}application/vnd.hyperfly;q=0`, "hyperfly"],
  ] as const)("parses quoted ranges and a single q in %s", (accept, kind) => {
    expect(negotiate(codecA.fingerprint, registry, { accept }).kind).toBe(kind);
  });

  test("an opt-out preserves the configured offer", () => {
    const decision = negotiate(codecA.fingerprint, registry, {
      accept: "application/vnd.hyperfly;q=0",
      offer: codecB.fingerprint,
    });
    expect(decision.headers["Hyperfly-Offer"]).toBe(codecB.fingerprint);
  });

  test("always varies, so a cache cannot cross-serve representations", () => {
    for (const accept of [acceptHeader([codecA.fingerprint]), undefined]) {
      expect(negotiate(accept, registry).headers["Vary"]).toBe("Hyperfly-Accept, Accept");
    }
  });

  test("an operator switch falls back without consulting the registry", () => {
    const decision = negotiate(acceptHeader([codecA.fingerprint]), registry, { enabled: false });
    expect(decision.kind).toBe("json");
  });

  test("client preference decides, which is what makes rotation work", () => {
    const both = new CodecRegistry([codecA as never, codecB as never]);
    expect(negotiate(acceptHeader([codecB.fingerprint, codecA.fingerprint]), both)).toMatchObject({
      headers: { "Hyperfly-Codec": codecB.fingerprint },
    });
    expect(negotiate(acceptHeader([codecA.fingerprint, codecB.fingerprint]), both)).toMatchObject({
      headers: { "Hyperfly-Codec": codecA.fingerprint },
    });
  });
});

describe("round trip over the protocol", () => {
  const registry = new CodecRegistry([codecA as never]);

  test("binary out, binary in", () => {
    const decision = negotiate<typeof value>(acceptHeader([codecA.fingerprint]), registry);
    const { body, headers } = encodeFor(decision, value);
    const decoded = decodeResponse<typeof value>(headers["Content-Type"], body, registry);
    expect(decoded).toEqual({ kind: "hyperfly", value });
  });

  test("json out, json in", () => {
    const decision = negotiate<typeof value>(undefined, registry);
    const { body, headers } = encodeFor(decision, value);
    expect(decodeResponse(headers["Content-Type"], body, registry)).toEqual({ kind: "json", value });
  });

  test.each(["{", new TextEncoder().encode("{")])("malformed JSON responses have a coded error and cause: %p", (body) => {
    try {
      decodeResponse("application/json", body, registry);
      throw new Error("expected invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError);
      expect(error).toBeInstanceOf(HyperflyError);
      expect((error as DecodeError).code).toBe("json");
      expect((error as DecodeError).cause).toBeInstanceOf(SyntaxError);
      expect((error as DecodeError).message).toBe(`$: ${((error as DecodeError).cause as Error).message}`);
    }
  });

  test("malformed JSON artifacts preserve the SyntaxError cause", () => {
    try {
      loadArtifact("{", codecA.fingerprint);
      throw new Error("expected invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(HyperflyError);
      expect(error).not.toBeInstanceOf(DecodeError);
      expect((error as HyperflyError).code).toBe("json");
      expect((error as HyperflyError).cause).toBeInstanceOf(SyntaxError);
      expect((error as HyperflyError).message).toContain("artifact is not JSON");
    }
  });

  test("JSON responses rethrow non-syntax parse failures unchanged", () => {
    const parse = JSON.parse;
    const cause = new TypeError("parse failed");
    try {
      JSON.parse = () => { throw cause; };
      expect(() => decodeResponse("application/json", "{}", registry)).toThrow(cause);
    } finally {
      JSON.parse = parse;
    }
  });

  test("a client without the codec reports a miss rather than guessing", () => {
    const decision = negotiate<typeof value>(acceptHeader([codecA.fingerprint]), registry);
    const { body, headers } = encodeFor(decision, value);
    const bare = new CodecRegistry();
    expect(decodeResponse(headers["Content-Type"], body, bare)).toEqual({
      kind: "unknown-codec",
      fingerprint: codecA.fingerprint,
    });
  });
});

describe("artifact discovery", () => {
  const registry = new CodecRegistry([codecA as never]);

  test("serves the canonical artifact, immutably", () => {
    const res = serveArtifact(`/.well-known/hyperfly/${codecA.fingerprint}`, registry)!;
    expect(res.status).toBe(200);
    expect(res.body).toBe(codecA.artifact);
    expect(res.headers["Cache-Control"]).toContain("immutable");
  });

  test("a client can bootstrap from the artifact and then speak binary", () => {
    const res = serveArtifact(`/.well-known/hyperfly/${codecA.fingerprint}`, registry)!;
    // the client derives its own codec from the parsed artifact, never trusting the text
    const parsed = JSON.parse(res.body) as { plan: { layout: string }; ir: IRNode };
    const rebuilt = compileIR(parsed.ir, { plan: parsed.plan.layout as "row" });
    expect(rebuilt.fingerprint).toBe(codecA.fingerprint);
    expect(rebuilt.decode(codecA.encode(value as never))).toEqual(value as never);
  });

  test("unknown and malformed fingerprints are 404, not errors", () => {
    expect(serveArtifact(`/.well-known/hyperfly/${"f".repeat(32)}`, registry)!.status).toBe(404);
    expect(serveArtifact("/.well-known/hyperfly/nope", registry)!.status).toBe(404);
  });

  test("unrelated paths are not ours", () => {
    expect(serveArtifact("/v1/events", registry)).toBeUndefined();
  });
});

describe("rotation", () => {
  test("holding both codecs keeps every client served during a rollout", () => {
    const registry = new CodecRegistry([codecA as never]);
    const oldClient = acceptHeader([codecA.fingerprint]);
    const newClient = acceptHeader([codecB.fingerprint, codecA.fingerprint]);

    expect(negotiate(newClient, registry).kind).toBe("hyperfly");
    registry.add(codecB as never);
    expect(negotiate(newClient, registry)).toMatchObject({ headers: { "Hyperfly-Codec": codecB.fingerprint } });
    expect(negotiate(oldClient, registry)).toMatchObject({ headers: { "Hyperfly-Codec": codecA.fingerprint } });

    registry.remove(codecA.fingerprint);
    expect(negotiate(newClient, registry)).toMatchObject({ headers: { "Hyperfly-Codec": codecB.fingerprint } });
    expect(negotiate(oldClient, registry).kind).toBe("json");
  });
});

describe("header name constants", () => {
  test("are the lowercase forms a fetch Headers lookup uses", () => {
    expect(ACCEPT_HEADER).toBe("hyperfly-accept");
  });
});

describe("fetch adapter", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";

  test("responds in binary to a client that holds the codec", async () => {
    const request = new Request(url, { headers: { "Hyperfly-Accept": codecA.fingerprint } });
    const response = respond(request, value, registry);
    expect(response.headers.get("content-type")).toBe(HYPERFLY_MEDIA_TYPE);
    expect(response.headers.get("vary")).toBe("Hyperfly-Accept, Accept");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(codecA.decode(bytes as never)).toEqual(value as never);
  });

  test("responds in JSON to a plain client", async () => {
    const response = respond(new Request(url), value, registry);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(value);
  });

  test("honours the request Accept opt-out", async () => {
    const request = new Request(url, {
      headers: { "Hyperfly-Accept": codecA.fingerprint, Accept: "application/vnd.hyperfly;q=0" },
    });
    const response = respond(request, value, registry);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("hyperfly-offer")).toBe(codecA.fingerprint);
    expect(response.headers.get("hyperfly-codec")).toBeNull();
    expect(response.headers.get("vary")).toBe("Hyperfly-Accept, Accept");
    expect(await response.json()).toEqual(value);
    for (const accept of [null, "application/vnd.hyperfly;q=1"]) {
      expect(respond(request, value, registry, { accept }).headers.get("content-type")).toBe(HYPERFLY_MEDIA_TYPE);
    }
  });

  test("an explicit Accept option can opt out", () => {
    const request = new Request(url, { headers: { "Hyperfly-Accept": codecA.fingerprint } });
    expect(respond(request, value, registry, {
      accept: "application/vnd.hyperfly;q=0",
    }).headers.get("content-type")).toBe("application/json");
  });

  test("falls back to JSON and reports encoder limit refusals", async () => {
    const limited = compileIR<string[]>({ kind: "array", element: { kind: "literal", value: "x" } }, {
      limits: { maxAmplification: 1 },
    });
    const values = Array.from({ length: 5 }, () => "x");
    const errors: EncodeError[] = [];
    const response = respond(new Request(url, {
      headers: { "Hyperfly-Accept": limited.fingerprint },
    }), values, new CodecRegistry([limited as never]), {
      onFallback: (error) => { errors.push(error); },
      headers: {
        "hYpErFlY-CoDeC": "caller-codec",
        "hYpErFlY-OfFeR": "caller-offer",
        "cOnTeNt-TyPe": "text/plain",
        "cOnTeNt-LeNgTh": "999",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("hyperfly-offer")).toBe(limited.fingerprint);
    expect(response.headers.get("hyperfly-codec")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("vary")).toBe("Hyperfly-Accept, Accept");
    expect(await response.json()).toEqual(values);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EncodeError);
    expect(errors[0]!.code).toBe("limit");
  });

  test("falls back to JSON on an encoder byte budget refusal", async () => {
    const dense = compileIR<string[]>({ kind: "array", element: { kind: "literal", value: "x".repeat(64) } });
    const values = Array.from({ length: 3 }, () => "x".repeat(64));
    const errors: EncodeError[] = [];
    const response = respond(new Request(url, {
      headers: { "Hyperfly-Accept": dense.fingerprint },
    }), values, new CodecRegistry([dense as never]), {
      onFallback: (error) => { errors.push(error); },
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(values);
    expect(errors.map((error) => error.code)).toEqual(["limit"]);
    expect(errors[0]!.message).toContain("byte budget");
  });

  test.each(["row", "columnar"] as const)("falls back to JSON on a %s encoder depth refusal", async (plan) => {
    const shallow = compileIR<{ s: string[] }[]>({
      kind: "array",
      element: { kind: "struct", fields: [{ name: "s", type: { kind: "array", element: { kind: "string" } } }] },
    }, { plan, limits: { maxDepth: 1 } });
    const values = [{ s: ["a"] }];
    const errors: EncodeError[] = [];
    const response = respond(new Request(url, {
      headers: { "Hyperfly-Accept": shallow.fingerprint },
    }), values, new CodecRegistry([shallow as never]), {
      onFallback: (error) => { errors.push(error); },
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(values);
    expect(errors.map((error) => error.code)).toEqual(["depth"]);
  });

  for (const plan of ["row", "columnar"] as const) {
    test.each(["maxItems", "maxByteLength"] as const)(`falls back to JSON on a ${plan} encoder %s refusal`, async (limit) => {
      const limited = compileIR<{ s: string }[]>({
        kind: "array",
        element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
      }, { plan, limits: { [limit]: 1 } });
      const values = [{ s: "ab" }, { s: "cd" }];
      const errors: EncodeError[] = [];
      const response = respond(new Request(url, {
        headers: { "Hyperfly-Accept": limited.fingerprint },
      }), values, new CodecRegistry([limited as never]), {
        onFallback: (error) => { errors.push(error); },
      });
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("hyperfly-offer")).toBe(limited.fingerprint);
      expect(await response.json()).toEqual(values);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(EncodeError);
      expect(errors[0]!.code).toBe("limit");
    });
  }

  test("falls back to JSON on a columnar leaf depth refusal", async () => {
    const limited = compileIR<{ s: string }[]>({
      kind: "array",
      element: { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] },
    }, { plan: "columnar", limits: { maxDepth: 1 } });
    const values = [{ s: "a" }];
    const errors: EncodeError[] = [];
    const response = respond(new Request(url, {
      headers: { "Hyperfly-Accept": limited.fingerprint },
    }), values, new CodecRegistry([limited as never]), {
      onFallback: (error) => { errors.push(error); },
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(values);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EncodeError);
    expect(errors[0]!.code).toBe("depth");
  });

  test.each([
    ["range", { kind: "int", min: 0 }, -1],
    ["required", { kind: "struct", fields: [{ name: "s", type: { kind: "string" } }] }, {}],
    ["utf8", { kind: "string" }, "\ud800"],
    ["float", { kind: "float64" }, Infinity],
  ] as const)("rethrows encoder %s errors without reporting a fallback", (code, ir, value) => {
    const codec = compileIR(ir as IRNode);
    const errors: EncodeError[] = [];
    const decision = negotiate(codec.fingerprint, new CodecRegistry([codec as never]));
    const run = () => encodeFor(decision, value, { onFallback: (error) => { errors.push(error); } });
    expect(run).toThrow(EncodeError);
    expect(run).toThrow(expect.objectContaining({ code }));
    expect(errors).toEqual([]);
  });

  test("rethrows encoder type errors without reporting a fallback", () => {
    const errors: EncodeError[] = [];
    const request = new Request(url, { headers: { "Hyperfly-Accept": codecA.fingerprint } });
    expect(() => respond(request, { id: 7, n: 7 } as never, registry, {
      onFallback: (error) => { errors.push(error); },
    })).toThrow(EncodeError);
    expect(errors).toEqual([]);
  });

  test("discovery answers its own paths and declines others", async () => {
    const hit = discovery(new Request(`https://example.test/.well-known/hyperfly/${codecA.fingerprint}`), registry);
    expect(hit!.status).toBe(200);
    expect(await hit!.text()).toBe(codecA.artifact);
    expect(discovery(new Request(url), registry)).toBeUndefined();
  });

  test("reads a binary request body, and refuses one it cannot read", async () => {
    const encoded = codecA.encode(value as never);
    const ok = await readBody<typeof value>(
      new Request(url, { method: "POST", body: encoded as BodyInit, headers: { "Content-Type": HYPERFLY_MEDIA_TYPE } }),
      registry,
    );
    expect(ok).toEqual({ ok: true, value });

    const stranger = await readBody(
      new Request(url, { method: "POST", body: codecB.encode(value as never) as BodyInit, headers: { "Content-Type": HYPERFLY_MEDIA_TYPE } }),
      registry,
    );
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) {
      expect(stranger.response.status).toBe(415);
      expect(stranger.response.headers.get("hyperfly-offer")).toBe(codecA.fingerprint);
    }
  });

  test("a JSON request body still works", async () => {
    const result = await readBody<typeof value>(
      new Request(url, { method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } }),
      registry,
    );
    expect(result).toEqual({ ok: true, value });
  });
});

describe("request content types", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";

  test("rejects unsupported media types without reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
        throw new Error("body must not be read");
      },
    }, { highWaterMark: 0 });
    const request = new Request(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain", "Content-Length": String(DEFAULT_MAX_BODY_BYTES + 1) },
    });
    const result = await readBody(request, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
      expect(result.response.body).toBeNull();
      expect([...result.response.headers]).toEqual([]);
    }
    expect(pulled).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });

  test.each([
    "application/json", "application/problem+json", "application/vnd.x+json",
    "!#$%&'*+-.^_`|~0123456789/!#$%&'*+-.^_`|~0123456789+json",
    " \tAPPLICATION/JSON\t ; charset=utf-8",
  ])(
    "accepts JSON with %s",
    async (contentType) => {
      const result = await readBody(new Request(url, {
        method: "POST",
        body: JSON.stringify(value),
        headers: { "Content-Type": contentType },
      }), registry);
      expect(result).toEqual({ ok: true, value });
    },
  );

  test.each([
    "foo+json", "+json", "application/+json", "/problem+json", "application//problem+json",
    "application/problem +json", "application/problem@+json", "app(lication/problem+json",
  ])("rejects invalid JSON essence %s", async (contentType) => {
    const request = new Request(url, {
      method: "POST",
      body: JSON.stringify(value),
      headers: { "Content-Type": contentType },
    });
    const result = await readBody(request, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(415);
    expect(request.bodyUsed).toBe(false);
  });

  test("an absent content type defaults to JSON", async () => {
    const request = new Request(url, { method: "POST", body: new TextEncoder().encode(JSON.stringify(value)) });
    expect(request.headers.get("content-type")).toBeNull();
    expect(await readBody(request, registry)).toEqual({ ok: true, value });
  });

  test.each([
    ["malformed JSON", new TextEncoder().encode("{")],
    ["invalid UTF-8 JSON", new Uint8Array([0x22, 0xff, 0x22])],
  ])("rejects %s", async (_, body) => {
    const result = await readBody(new Request(url, {
      method: "POST",
      body: body as BodyInit,
      headers: { "Content-Type": "application/json" },
    }), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(result.response.body).toBeNull();
    }
  });

  test("a null body is empty and fails JSON parsing", async () => {
    const result = await readBody(new Request(url, { method: "POST" }), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});

describe("request body limits", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";

  test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxBytes %s synchronously without reading",
    (maxBytes) => {
      let pulled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() { pulled = true; },
      }, { highWaterMark: 0 });
      const request = new Request(url, { method: "POST", body });
      expect(() => readBody(request, registry, { maxBytes })).toThrow(RangeError);
      expect(pulled).toBe(false);
      expect(request.bodyUsed).toBe(false);
    },
  );

  test.each(["throws", "rejects", "never resolves"])("returns 413 promptly when cancel %s", async (mode) => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2)); },
      cancel() {
        if (mode === "throws") throw new Error("cancel failed");
        if (mode === "rejects") return Promise.reject(new Error("cancel failed"));
        return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 });
    const request = new Request(url, { method: "POST", body });
    const result = await readBody(request, registry, { maxBytes: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(body.locked).toBe(false);
  }, 500);

  test("returns 413 when reader.cancel throws synchronously and releaseLock throws", async () => {
    const request = new Request(url, { method: "POST", body: new Uint8Array(2) });
    const reader = request.body!.getReader();
    reader.cancel = () => { throw new Error("cancel failed"); };
    const releaseLock = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      releaseLock();
      throw new Error("release failed");
    };
    request.body!.getReader = () => reader;
    const result = await readBody(request, registry, { maxBytes: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  test("returns 400 when reading the stream rejects", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() { throw new Error("client aborted"); },
    }, { highWaterMark: 0 });
    const result = await readBody(new Request(url, { method: "POST", body }), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(body.locked).toBe(false);
  });

  test("skips empty chunks within a zero-byte limit", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ < 100_000) controller.enqueue(new Uint8Array(0));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const result = await readBody(new Request(url, { method: "POST", body }), registry, { maxBytes: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(pulls).toBe(100_001);
  });

  test("returns 413 promptly with an unread request clone", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2)); },
    }, { highWaterMark: 0 });
    const request = new Request(url, { method: "POST", body });
    const clone = request.clone();
    try {
      const result = await readBody(request, registry, { maxBytes: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(413);
      expect(clone.bodyUsed).toBe(false);
    } finally {
      await clone.body!.cancel();
    }
  }, 500);

  test("accepts zero maxBytes and a safe integer limit", async () => {
    const result = await readBody(new Request(url, { method: "POST", body: "0" }), registry, { maxBytes: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(await readBody(new Request(url, { method: "POST", body: "0" }), registry, {
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).toEqual({ ok: true, value: 0 });
  });

  test("rejects an oversized Content-Length without reading the body", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
        throw new Error("body must not be read");
      },
    }, { highWaterMark: 0 });
    const request = new Request(url, {
      method: "POST",
      body,
      headers: { "Content-Length": String(DEFAULT_MAX_BODY_BYTES + 1) },
    });
    const result = await readBody(request, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(result.response.body).toBeNull();
    }
    expect(pulled).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });

  test("cancels a chunked stream as soon as it exceeds the limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("123"));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const request = new Request(url, { method: "POST", body });
    expect(request.headers.get("content-length")).toBeNull();
    const result = await readBody(request, registry, { maxBytes: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(result.response.body).toBeNull();
    }
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  test("accepts exactly maxBytes across chunks, counting UTF-8 bytes", async () => {
    const bytes = new TextEncoder().encode('"é"');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 2));
        controller.enqueue(bytes.subarray(2));
        controller.close();
      },
    });
    expect(await readBody(new Request(url, { method: "POST", body }), registry, {
      maxBytes: bytes.byteLength,
    })).toEqual({ ok: true, value: "é" });
  });

  test.each(["-1", "1.5", "1x"])("ignores invalid Content-Length %s", async (contentLength) => {
    const result = await readBody(new Request(url, {
      method: "POST",
      body: new TextEncoder().encode("0"),
      headers: { "Content-Length": contentLength },
    }), registry, { maxBytes: 1 });
    expect(result).toEqual({ ok: true, value: 0 });
  });
});

describe("binary request validation", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";

  test.each([
    { name: "unsupported content type before malformed body", contentType: "text/plain", maxBytes: DEFAULT_MAX_BODY_BYTES, codecHeader: null, status: 415 },
    { name: "size limit before unknown fingerprint", contentType: HYPERFLY_MEDIA_TYPE, maxBytes: HEADER_SIZE - 1, codecHeader: null, status: 413 },
    { name: "codec mismatch before unknown fingerprint", contentType: HYPERFLY_MEDIA_TYPE, maxBytes: DEFAULT_MAX_BODY_BYTES, codecHeader: codecA.fingerprint, status: 400 },
  ])("prioritizes $name", async ({ contentType, maxBytes, codecHeader, status }) => {
    const bytes = codecB.encode(value as never).slice();
    bytes.fill(0xff, 3, HEADER_SIZE);
    const headers = new Headers({ "Content-Type": contentType });
    if (codecHeader !== null) headers.set("Hyperfly-Codec", codecHeader);
    const result = await readBody(new Request(url, {
      method: "POST",
      body: contentType === "text/plain" ? "garbage" : bytes as BodyInit,
      headers,
    }), registry, { maxBytes });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(status);
      expect(result.response.body).toBeNull();
      expect(result.response.headers.get("hyperfly-offer")).toBeNull();
    }
  });

  test.each([null, codecA.fingerprint, ` \t${codecA.fingerprint}\t `])("accepts codec header %s", async (header) => {
    const headers = new Headers({ "Content-Type": HYPERFLY_MEDIA_TYPE });
    if (header !== null) headers.set("Hyperfly-Codec", header);
    expect(await readBody(new Request(url, {
      method: "POST",
      body: codecA.encode(value as never) as BodyInit,
      headers,
    }), registry)).toEqual({ ok: true, value });
  });

  test.each([codecB.fingerprint, codecA.fingerprint.toUpperCase(), "", "malformed", `${codecA.fingerprint},${codecA.fingerprint}`])(
    "rejects codec header %s before registry lookup",
    async (header) => {
      const unchecked = new CodecRegistry();
      unchecked.get = () => { throw new Error("registry must not be consulted"); };
      const result = await readBody(new Request(url, {
        method: "POST",
        body: codecA.encode(value as never) as BodyInit,
        headers: { "Content-Type": HYPERFLY_MEDIA_TYPE, "Hyperfly-Codec": header },
      }), unchecked);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        expect(result.response.body).toBeNull();
        expect(result.response.headers.get("hyperfly-offer")).toBeNull();
      }
    },
  );

  test.each(["short body", "wrong magic", "wrong version", "corrupted body"])("rejects %s", async (kind) => {
    let bytes = codecA.encode(value as never).slice();
    if (kind === "short body") bytes = bytes.subarray(0, HEADER_SIZE - 1);
    if (kind === "wrong magic") bytes[0] = 0;
    if (kind === "wrong version") bytes[2] = WIRE_VERSION + 1;
    if (kind === "corrupted body") bytes = bytes.subarray(0, HEADER_SIZE);
    const result = await readBody(new Request(url, {
      method: "POST",
      body: bytes as BodyInit,
      headers: { "Content-Type": HYPERFLY_MEDIA_TYPE },
    }), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(result.response.body).toBeNull();
      expect(result.response.headers.get("hyperfly-offer")).toBeNull();
    }
  });

  test("offers a known codec for an unknown fingerprint", async () => {
    const bytes = codecA.encode(value as never).slice();
    bytes.fill(0xff, 3, HEADER_SIZE);
    for (const codecs of [registry, new CodecRegistry()]) {
      const result = await readBody(new Request(url, {
        method: "POST",
        body: bytes as BodyInit,
        headers: { "Content-Type": HYPERFLY_MEDIA_TYPE },
      }), codecs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(415);
        expect(result.response.body).toBeNull();
        expect(result.response.headers.get("hyperfly-offer")).toBe(codecs.fingerprints[0] ?? null);
      }
    }
  });

  test.each(["APPLICATION/VND.HYPERFLY", "application/vnd.hyperfly; charset=x"])(
    "accepts %s",
    async (contentType) => {
      expect(await readBody(new Request(url, {
        method: "POST",
        body: codecA.encode(value as never) as BodyInit,
        headers: { "Content-Type": contentType },
      }), registry)).toEqual({ ok: true, value });
    },
  );

  test("rejects a prefix lookalike", async () => {
    const result = await readBody(new Request(url, {
      method: "POST",
      body: codecA.encode(value as never) as BodyInit,
      headers: { "Content-Type": `${HYPERFLY_MEDIA_TYPE}-x` },
    }), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(415);
  });

  test("rethrows unexpected codec errors", async () => {
    const error = new Error("codec failure");
    const broken = new CodecRegistry([{
      ...codecA,
      decode() { throw error; },
    } as never]);
    const request = new Request(url, {
      method: "POST",
      body: codecA.encode(value as never) as BodyInit,
      headers: { "Content-Type": HYPERFLY_MEDIA_TYPE },
    });
    await expect(readBody(request, broken)).rejects.toBe(error);
  });
});

describe("response envelope validation", () => {
  const registry = new CodecRegistry([codecA as never]);

  test.each(["short body", "wrong magic", "wrong version"])("throws DecodeError for %s", (kind) => {
    let bytes = codecA.encode(value as never).slice();
    if (kind === "short body") bytes = bytes.subarray(0, HEADER_SIZE - 1);
    if (kind === "wrong magic") bytes[1] = 0;
    if (kind === "wrong version") bytes[2] = WIRE_VERSION + 1;
    expect(() => decodeResponse(HYPERFLY_MEDIA_TYPE, bytes, new CodecRegistry())).toThrow(DecodeError);
    try {
      decodeResponse(HYPERFLY_MEDIA_TYPE, bytes, registry);
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe("header");
    }
  });

  test.each(["APPLICATION/VND.HYPERFLY", "application/vnd.hyperfly; charset=x"])("accepts %s", (contentType) => {
    expect(decodeResponse(contentType, codecA.encode(value as never), registry)).toEqual({ kind: "hyperfly", value });
  });

  test("treats a prefix lookalike as JSON", () => {
    expect(decodeResponse(`${HYPERFLY_MEDIA_TYPE}-x`, JSON.stringify(value), registry)).toEqual({ kind: "json", value });
  });
});

describe("response header merging", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";

  test.each([
    ["vary", "Origin", "Origin, Hyperfly-Accept, Accept"],
    ["Vary", "hyperfly-accept", "hyperfly-accept, Accept"],
    ["Vary", "Origin, origin, Hyperfly-Accept, HYPERFLY-ACCEPT, Accept-Encoding", "Origin, Hyperfly-Accept, Accept-Encoding, Accept"],
    ["Vary", "accept, ACCEPT, hyperfly-accept", "accept, hyperfly-accept"],
  ])("merges %s: %s", (name, tokens, expected) => {
    const response = respond(new Request(url), value, registry, { headers: { [name]: tokens } });
    expect(response.headers.get("vary")).toBe(expected);
  });

  test("negotiation headers override caller values", () => {
    for (const accept of [undefined, codecA.fingerprint]) {
      const request = new Request(url, { headers: accept ? { "Hyperfly-Accept": accept } : {} });
      const response = respond(request, value, registry, {
        status: 201,
        headers: {
          "content-type": "text/plain",
          "hyperfly-codec": "caller-codec",
          "hyperfly-offer": "caller-offer",
          "cOnTeNt-LeNgTh": "999",
          "x-custom": "kept",
        },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toBe(accept ? HYPERFLY_MEDIA_TYPE : "application/json");
      expect(response.headers.get(accept ? "hyperfly-codec" : "hyperfly-offer")).toBe(codecA.fingerprint);
      expect(response.headers.get(accept ? "hyperfly-offer" : "hyperfly-codec")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("x-custom")).toBe("kept");
    }
  });

  test("clears a caller offer when negotiation has no offer", () => {
    for (const options of [{ enabled: false }, {}]) {
      const response = respond(new Request(url), value, new CodecRegistry(), {
        ...options,
        headers: { "Hyperfly-Offer": "caller-offer", "Hyperfly-Codec": "caller-codec" },
      });
      expect(response.headers.get("hyperfly-offer")).toBeNull();
      expect(response.headers.get("hyperfly-codec")).toBeNull();
    }
  });
});

describe("hostile header performance", () => {
  const registry = new CodecRegistry([codecA as never]);
  const url = "https://example.test/v1/thing";
  const spaces = " ".repeat(100_000);

  test.each([
    `application/vnd.hyperfly${spaces}x`,
    `application/vnd.hyperfly;q${spaces}x=0`,
    `application/vnd.hyperfly;q=0${spaces}x`,
  ])("Accept OWS parsing completes within 50 ms (%#)", (accept) => {
    const start = performance.now();
    const decision = negotiate(codecA.fingerprint, registry, { accept });
    const elapsed = performance.now() - start;
    expect(decision.kind).toBe("hyperfly");
    expect(elapsed).toBeLessThan(50);
  });

  test.each(["Content-Type", "Hyperfly-Codec"])("%s OWS parsing completes within 50 ms", async (header) => {
    const request = new Request(url, {
      method: "POST",
      body: codecA.encode(value as never) as BodyInit,
      headers: {
        "Content-Type": HYPERFLY_MEDIA_TYPE,
        [header]: `${header === "Content-Type" ? "application/json" : codecA.fingerprint}${spaces}x`,
      },
    });
    const start = performance.now();
    const result = await readBody(request, registry);
    const elapsed = performance.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(header === "Content-Type" ? 415 : 400);
    expect(elapsed).toBeLessThan(50);
  });
});
