/**
 * A TypeScript server speaking the negotiation protocol. Paired with client.py, this
 * is the end-to-end proof the golden vectors imply but cannot demonstrate: two
 * independent implementations agreeing over a real HTTP exchange.
 */
import { z } from "zod";
import { CodecRegistry, train } from "hyperfly";
import { compile, toIR } from "hyperfly/zod";
import { discovery, respond } from "hyperfly/http";

const EventResponse = z.object({
  route: z.literal("events"),
  cursor: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["user.login", "file.upload", "billing.charge"]),
      actorEmail: z.string(),
      ok: z.boolean(),
      at: z.number().int().min(0),
    }),
  ),
});

const ACTORS = ["ada@acme.io", "grace@acme.io", "linus@globex.com"];
const sample = (n: number) => ({
  route: "events" as const,
  cursor: null,
  events: Array.from({ length: n }, (_, i) => ({
    id: `evt_${i.toString(16).padStart(6, "0")}`,
    type: (["user.login", "file.upload", "billing.charge"] as const)[i % 3]!,
    actorEmail: ACTORS[i % ACTORS.length]!,
    ok: i % 7 !== 0,
    at: 1755000000000 + i * 1000,
  })),
});

const profile = train(toIR(EventResponse), Array.from({ length: 20 }, (_, i) => sample(10 + i)));
const registry = new CodecRegistry([
  compile(EventResponse, { plan: "columnar" }) as never,
  compile(EventResponse, { plan: "columnar", profile }) as never,
]);

const port = Number(process.env.PORT ?? 8787);
Bun.serve({
  port,
  fetch(request) {
    const artifact = discovery(request, registry);
    if (artifact) return artifact;

    const url = new URL(request.url);
    if (url.pathname === "/v1/events") {
      return respond(request, sample(24), registry);
    }
    if (url.pathname === "/fingerprints") {
      return Response.json(registry.fingerprints);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`interop server on :${port} — ${registry.size} codecs`);
