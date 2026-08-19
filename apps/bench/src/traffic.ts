import { intIn, mulberry32, pick } from "./prng.js";
import { DeviceResponse } from "./corpora/devices.js";
import { FeedResponse } from "./corpora/feed.js";
import type { z } from "zod";

/**
 * Sampled traffic for one route: many responses drawn from a stable universe, the
 * way a real endpoint behaves. Profiles are trained on one slice and measured on a
 * held-out slice, so the numbers reflect generalization rather than memorization.
 */
export interface Traffic<T> {
  train: T[];
  holdout: T[];
}

const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"] as const;
const STATUSES = ["online", "online", "online", "online", "offline", "degraded", "provisioning", "unknown"] as const;
const TAGS = ["fleet-a", "fleet-b", "fleet-a", "pilot", "lab", null, null, null];

/** A fixed device fleet: the same ids and tags recur across every response. */
export function devicesTraffic(
  responses: number,
  perResponse: number,
  seed: number,
): Traffic<z.output<typeof DeviceResponse>> {
  const rng = mulberry32(seed);
  const fleet = Array.from({ length: 400 }, (_, i) => ({
    id: `dev-${String(intIn(rng, 0, 99)).padStart(2, "0")}-${String(i).padStart(5, "0")}`,
    region: pick(rng, REGIONS),
    tag: pick(rng, TAGS),
    firmwareMajor: intIn(rng, 1, 4),
    firmwareMinor: intIn(rng, 0, 27),
  }));

  const base = 1754000000000;
  const all = Array.from({ length: responses }, (_, r) => ({
    route: "devices" as const,
    page: 0,
    devices: Array.from({ length: perResponse }, () => {
      const unit = fleet[intIn(rng, 0, fleet.length - 1)]!;
      return {
        ...unit,
        status: pick(rng, STATUSES),
        battery: intIn(rng, 0, 100),
        rssi: intIn(rng, -120, 0),
        uptimeSec: intIn(rng, 0, 40000000),
        tempC: Math.round((15 + rng() * 45) * 10) / 10,
        alarms: rng() < 0.85 ? 0 : intIn(rng, 1, 12),
        shadowSynced: rng() < 0.93,
        lastSeen: base + r * 60000 - intIn(rng, 0, 86400000),
      };
    }),
  }));

  const split = Math.floor(all.length * 0.8);
  return { train: all.slice(0, split), holdout: all.slice(split) };
}

const HANDLES = Array.from({ length: 120 }, (_, i) => {
  const first = ["ada", "linus", "grace", "alan", "edsger", "barbara", "donald", "radia", "ken", "margaret"][i % 10]!;
  const last = ["hopper", "torvalds", "lovelace", "turing", "dijkstra", "liskov", "knuth", "perlman", "thompson", "hamilton"][
    Math.floor(i / 10) % 10
  ]!;
  return { handle: `@${first}${last}${i}`, name: `${first[0]!.toUpperCase()}${first.slice(1)} ${last[0]!.toUpperCase()}${last.slice(1)}` };
});

const LEXICON = (
  "the of and to in is that it was for on are as with his they at be this have from or had by hot word " +
  "but what some we can out other were all there when up use your how said an each she which do their time " +
  "deploy latency cluster rollout incident postmortem throughput regression release migration schema payload"
).split(" ");

/** A recurring cast of authors posting about a recurring vocabulary. */
export function feedTraffic(
  responses: number,
  perResponse: number,
  seed: number,
): Traffic<z.output<typeof FeedResponse>> {
  const rng = mulberry32(seed);
  const base = 1754500000000;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
  const authors = HANDLES.map((h) => ({ ...h, id: hex(12), verified: rng() < 0.2 }));

  const all = Array.from({ length: responses }, () => ({
    route: "feed" as const,
    posts: Array.from({ length: perResponse }, () => {
      const author = authors[intIn(rng, 0, authors.length - 1)]!;
      const sentences = Array.from({ length: intIn(rng, 1, 3) }, () => {
        const words = Array.from({ length: intIn(rng, 8, 24) }, () => pick(rng, LEXICON));
        const s = words.join(" ");
        return s.charAt(0).toUpperCase() + s.slice(1) + ".";
      });
      return {
        id: hex(16),
        author,
        body: sentences.join(" "),
        lang: pick(rng, ["en", "en", "en", "de", "fr", "es", "ja"] as const),
        likes: intIn(rng, 0, 50000),
        replies: intIn(rng, 0, 2000),
        reposts: intIn(rng, 0, 8000),
        createdAt: base - intIn(rng, 0, 604800000),
        inReplyTo: null,
      };
    }),
  }));

  const split = Math.floor(all.length * 0.8);
  return { train: all.slice(0, split), holdout: all.slice(split) };
}

export { DeviceResponse, FeedResponse };
