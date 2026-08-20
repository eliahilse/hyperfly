import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CodecRegistry, type IRNode } from "../src/index.js";
import { compileIR } from "../src/index.js";
import {
  ACCEPT_HEADER,
  HYPERFLY_MEDIA_TYPE,
  acceptHeader,
  decodeResponse,
  encodeFor,
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
  test("keeps order, lowercases, drops junk and duplicates", () => {
    const a = "A".repeat(32);
    const parsed = parseAccept(`${a}, not-a-fingerprint, ${a.toLowerCase()}, ${"b".repeat(32)}`);
    expect(parsed).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  test("absent or empty header yields nothing", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept("")).toEqual([]);
  });

  test("a hostile header is bounded, not fatal", () => {
    const flood = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(32, "0")).join(",");
    expect(parseAccept(flood).length).toBeLessThanOrEqual(32);
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

  test("always varies, so a cache cannot cross-serve representations", () => {
    for (const accept of [acceptHeader([codecA.fingerprint]), undefined]) {
      expect(negotiate(accept, registry).headers["Vary"]).toBe("Hyperfly-Accept");
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
    expect(response.headers.get("vary")).toBe("Hyperfly-Accept");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(codecA.decode(bytes as never)).toEqual(value as never);
  });

  test("responds in JSON to a plain client", async () => {
    const response = respond(new Request(url), value, registry);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(value);
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
