import { expect, test } from "bun:test";
import { z } from "zod";
import {
  decodeResponse,
  discovery,
  encodeFor,
  negotiate,
  readBody,
  respond,
  type DecodedResponse,
  type FallbackReason,
  type HyperflyNegotiation,
  type JsonNegotiation,
  type Negotiation,
  type ReadBodyResult,
  type RequestRefusal,
} from "../src/http.js";
import { CodecRegistry, compileIR, type Codec } from "../src/index.js";
import { compile } from "../src/zod.js";

const payload = { id: "evt_1", count: 7 };
const schema = z.object({ id: z.string(), count: z.number().int() });
const codec = compile(schema);
const previousCodec = compile(schema, { plan: "columnar" });

const registry = new CodecRegistry([codec, previousCodec]);

const server = {
  fetch(request: Request) {
    return (
      discovery(request, registry) ??      // .well-known artifact serving
      respond(request, payload, registry)  // binary if the client can read it, else JSON
    );
  },
};

test("registry accepts typed and IR codecs", () => {
  const codecs = new CodecRegistry([
    compile(z.object({ id: z.string() })),
    compileIR({ kind: "int" }),
  ]);
  expect(codecs.size).toBe(2);
  expect(codecs.add(codec)).toBe(codecs);

  const stored: Codec<unknown> | undefined = codecs.get(codec.fingerprint);
  const selected: Codec<unknown> | undefined = codecs.select([codec.fingerprint]);
  expect(stored).toBe(codec);
  expect(selected).toBe(codec);
  expect(stored!.decode(stored!.encode(payload))).toEqual(payload);
  expect(selected!.decodeBody(selected!.encodeBody(payload))).toEqual(payload);
});

test("README HTTP example serves typed codecs", async () => {
  const request = new Request("https://example.test/events", {
    headers: { "Hyperfly-Accept": codec.fingerprint },
  });
  const response = await server.fetch(request);
  expect(response.headers.get("Hyperfly-Codec")).toBe(codec.fingerprint);
  expect(codec.decode(new Uint8Array(await response.arrayBuffer()))).toEqual(payload);
});

type Equal<X, Y> = (<V>() => V extends X ? 1 : 2) extends (<V>() => V extends Y ? 1 : 2) ? true : false;
const assertType = <T extends true>(value?: T): T | undefined => value;

test("registry payload types are inferred and flow through the HTTP helpers", async () => {
  type Payload = z.infer<typeof schema>;
  const other = compile(z.object({ name: z.string() }));
  const mixed = new CodecRegistry([codec, other]);
  const withIR = new CodecRegistry([codec, compileIR({ kind: "int" })]);
  const explicit = new CodecRegistry<Payload | { name: string }>([codec, other]);
  assertType<Equal<typeof registry, CodecRegistry<Payload>>>();
  assertType<Equal<typeof mixed, CodecRegistry<unknown>>>();
  assertType<Equal<typeof withIR, CodecRegistry<unknown>>>();
  assertType<Equal<typeof explicit, CodecRegistry<Payload | { name: string }>>>();
  assertType<Equal<CodecRegistry, CodecRegistry<unknown>>>();
  expect([mixed.size, withIR.size, explicit.size]).toEqual([2, 2, 2]);
  assertType<Equal<ReturnType<typeof registry.get>, Codec<Payload> | undefined>>();
  assertType<Equal<ReturnType<typeof registry.select>, Codec<Payload> | undefined>>();
  // @ts-expect-error a codec of another payload type
  const misfit = () => registry.add(other);
  const untyped: CodecRegistry = registry;
  expect(untyped.size).toBe(2);

  const decision = negotiate(codec.fingerprint, registry);
  assertType<Equal<typeof decision, Negotiation<Payload>>>();
  if (decision.kind === "hyperfly") assertType<Equal<typeof decision, HyperflyNegotiation<Payload>>>();
  else assertType<Equal<typeof decision, JsonNegotiation>>();
  assertType<Equal<JsonNegotiation["reason"], Exclude<FallbackReason, "encoder-limit">>>();
  // @ts-expect-error a value the registry's codecs cannot encode
  const mismatched = () => respond(new Request("https://example.test/"), { id: 1 }, registry);
  const literal = new CodecRegistry<"allowed">();
  // @ts-expect-error the value must not widen the registry's payload type
  const widened = () => respond(new Request("https://example.test/"), "wrong", literal);
  // @ts-expect-error the value must not widen the decision's payload type
  const widenedEncode = () => encodeFor(negotiate(null, literal), "wrong");
  expect([typeof misfit, typeof mismatched, typeof widened, typeof widenedEncode]).toEqual(["function", "function", "function", "function"]);

  const { body, headers } = encodeFor(decision, payload);
  const decoded = decodeResponse(headers["Content-Type"], body, registry);
  assertType<Equal<typeof decoded, DecodedResponse<Payload>>>();
  expect(decoded).toEqual({ kind: "hyperfly", value: payload });

  const read = await readBody(new Request("https://example.test/", { method: "POST", body: JSON.stringify(payload) }), registry);
  assertType<Equal<typeof read, ReadBodyResult<Payload>>>();
  if (!read.ok) assertType<Equal<typeof read.reason, RequestRefusal>>();
  expect(read).toEqual({ ok: true, value: payload });
  assertType<Equal<Awaited<ReturnType<typeof readBody<unknown>>>, ReadBodyResult<unknown>>>();
});
