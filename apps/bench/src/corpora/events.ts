import { z } from "zod";
import { intIn, mulberry32, pick } from "../prng.js";

export const EventResponse = z.object({
  route: z.literal("events"),
  cursor: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      type: z.enum([
        "user.login",
        "user.logout",
        "file.upload",
        "file.delete",
        "billing.charge",
        "billing.refund",
        "project.create",
        "project.archive",
        "member.invite",
        "member.remove",
      ]),
      actorId: z.string(),
      actorEmail: z.string(),
      resourceId: z.string(),
      resourceType: z.enum(["user", "file", "project", "invoice", "member", "apikey"]),
      ip: z.string(),
      userAgent: z.string(),
      region: z.enum(["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"]),
      durationMs: z.number().int().min(0).max(60000),
      ok: z.boolean(),
      at: z.number().int().min(0),
    }),
  ),
});

type ResourceType = z.output<typeof EventResponse>["events"][number]["resourceType"];

const EVENT_TYPES = [
  "user.login",
  "user.logout",
  "file.upload",
  "file.delete",
  "billing.charge",
  "billing.refund",
  "project.create",
  "project.archive",
  "member.invite",
  "member.remove",
] as const;

const RESOURCE_TYPES = ["user", "file", "project", "invoice", "member", "apikey"] as const;

const RESOURCE_PREFIX: Record<ResourceType, string> = {
  user: "usr",
  file: "file",
  project: "proj",
  invoice: "inv",
  member: "mem",
  apikey: "key",
};

const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"] as const;

const FIRST_NAMES = [
  "Ada",
  "Grace",
  "Alan",
  "Edsger",
  "Barbara",
  "Donald",
  "Radia",
  "Ken",
  "Margaret",
  "Linus",
  "Katherine",
  "Vint",
  "Tim",
  "Claude",
  "Hedy",
  "Marvin",
  "John",
  "Frances",
  "Dennis",
  "Brian",
];

const LAST_NAMES = [
  "Lovelace",
  "Hopper",
  "Turing",
  "Dijkstra",
  "Liskov",
  "Knuth",
  "Perlman",
  "Thompson",
  "Hamilton",
  "Torvalds",
  "Johnson",
  "Cerf",
  "Berners-Lee",
  "Shannon",
  "Lamarr",
  "Minsky",
  "Backus",
  "Allen",
  "Ritchie",
  "Kernighan",
];

const DOMAINS = ["acme.io", "globex.com", "initech.dev", "umbrella.co", "hooli.com", "starkindustries.com", "wayneenterprises.com", "piedpiper.io"];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/124.0.0.0 Safari/537.36",
  "curl/8.6.0",
  "PostmanRuntime/7.36.3",
  "okhttp/4.12.0",
  "python-requests/2.31.0",
];

function hexId(rng: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

function skewedPick<T>(rng: () => number, items: readonly T[]): T {
  const r = rng();
  return items[Math.floor(r * r * items.length)]!;
}

const universeRng = mulberry32(482910);

const ACTORS = Array.from({ length: 150 }, (_, i) => {
  const first = pick(universeRng, FIRST_NAMES);
  const last = pick(universeRng, LAST_NAMES);
  const domain = pick(universeRng, DOMAINS);
  return {
    id: `usr_${i.toString(36).padStart(4, "0")}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@${domain}`,
  };
});

const RESOURCES = RESOURCE_TYPES.reduce(
  (acc, type) => {
    acc[type] = Array.from({ length: 50 }, () => `${RESOURCE_PREFIX[type]}_${hexId(universeRng, 8)}`);
    return acc;
  },
  {} as Record<ResourceType, string[]>,
);

const IPS = Array.from({ length: 80 }, () => `${intIn(universeRng, 1, 223)}.${intIn(universeRng, 0, 255)}.${intIn(universeRng, 0, 255)}.${intIn(universeRng, 1, 254)}`);

export function eventsCorpus(count: number, seed: number): z.output<typeof EventResponse>[] {
  const rng = mulberry32(seed);
  const messages: z.output<typeof EventResponse>[] = [];
  const base = 1755000000000;
  let eventSeq = 0;
  for (let m = 0; m < count; m++) {
    const n = intIn(rng, 20, 50);
    const events = [];
    for (let i = 0; i < n; i++) {
      const resourceType = pick(rng, RESOURCE_TYPES);
      const actor = skewedPick(rng, ACTORS);
      events.push({
        id: `evt_${eventSeq.toString(36).padStart(6, "0")}_${hexId(rng, 8)}`,
        type: pick(rng, EVENT_TYPES),
        actorId: actor.id,
        actorEmail: actor.email,
        resourceId: skewedPick(rng, RESOURCES[resourceType]),
        resourceType,
        ip: skewedPick(rng, IPS),
        userAgent: skewedPick(rng, USER_AGENTS),
        region: pick(rng, REGIONS),
        durationMs: rng() < 0.9 ? intIn(rng, 5, 1200) : intIn(rng, 1200, 60000),
        ok: rng() < 0.92,
        at: base - intIn(rng, 0, 2592000000),
      });
      eventSeq++;
    }
    messages.push({
      route: "events",
      cursor: m < count - 1 ? hexId(rng, 16) : null,
      events,
    });
  }
  return messages;
}
