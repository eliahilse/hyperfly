import { expect, test } from "bun:test";
import { z } from "zod";
import { discovery, respond } from "../src/http.js";
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
