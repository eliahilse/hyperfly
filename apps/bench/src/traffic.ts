import type { z } from "zod";
import { CandleResponse } from "./corpora/candles.js";
import { DeviceResponse } from "./corpora/devices.js";
import { FeedResponse } from "./corpora/feed.js";
import { intIn, mulberry32, pick } from "./prng.js";

/**
 * A corpus is many independent response messages from one route, drawn from a stable
 * entity universe — the same devices, the same authors, the same instruments — because
 * that is what a real endpoint returns. Per-message sizes stay in the range APIs
 * actually serve (a page of records, not a ten-thousand-row dump).
 *
 * Dictionaries exist to exploit repetition ACROSS messages, so a corpus is the only
 * setting in which they can be measured honestly: one message cannot exhibit the
 * property being tested.
 */

/** Skewed toward the low index, the way real traffic concentrates on a few entities. */
function zipfIndex(rng: () => number, size: number): number {
  const r = rng();
  return Math.min(size - 1, Math.floor(r * r * size));
}

const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"] as const;
const STATUSES = ["online", "online", "online", "online", "offline", "degraded", "provisioning", "unknown"] as const;
const TAGS = ["fleet-a", "fleet-b", "fleet-a", "pilot", "lab", null, null, null];

/** GET /v1/devices — a page of telemetry from a fixed fleet. */
export function devicesCorpus(count: number, seed: number): z.output<typeof DeviceResponse>[] {
  const rng = mulberry32(seed);
  const fleet = Array.from({ length: 400 }, (_, i) => ({
    id: `dev-${String(intIn(rng, 0, 99)).padStart(2, "0")}-${String(i).padStart(5, "0")}`,
    region: pick(rng, REGIONS),
    tag: pick(rng, TAGS),
    firmwareMajor: intIn(rng, 1, 4),
    firmwareMinor: intIn(rng, 0, 27),
  }));
  const base = 1754000000000;

  return Array.from({ length: count }, (_, message) => ({
    route: "devices" as const,
    page: message % 20,
    devices: Array.from({ length: intIn(rng, 20, 50) }, () => {
      const unit = fleet[zipfIndex(rng, fleet.length)]!;
      return {
        ...unit,
        status: pick(rng, STATUSES),
        battery: intIn(rng, 0, 100),
        rssi: intIn(rng, -120, 0),
        uptimeSec: intIn(rng, 0, 40000000),
        tempC: Math.round((15 + rng() * 45) * 10) / 10,
        alarms: rng() < 0.85 ? 0 : intIn(rng, 1, 12),
        shadowSynced: rng() < 0.93,
        lastSeen: base + message * 60000 - intIn(rng, 0, 86400000),
      };
    }),
  }));
}

const SYMBOLS = [
  "HFLY-USD", "BTC-USD", "ETH-USD", "SOL-USD", "AAPL", "MSFT", "NVDA", "TSLA",
  "EUR-USD", "GBP-USD", "USD-JPY", "XAU-USD",
];
const INTERVALS = ["1m", "5m", "5m", "15m", "1h", "4h", "1d"] as const;

/** GET /v1/candles — a chart window, not a full history dump. */
export function candlesCorpus(count: number, seed: number): z.output<typeof CandleResponse>[] {
  const rng = mulberry32(seed);
  const opens = new Map(SYMBOLS.map((s) => [s, 20 + rng() * 300]));

  return Array.from({ length: count }, () => {
    const symbol = SYMBOLS[zipfIndex(rng, SYMBOLS.length)]!;
    let price = opens.get(symbol)!;
    let t = 1735689600000 + intIn(rng, 0, 5000) * 300000;
    const candles = Array.from({ length: intIn(rng, 20, 50) }, () => {
      const o = Math.round(price * 100) / 100;
      const c = Math.round((o + (rng() - 0.5) * 0.8) * 100) / 100;
      const row = {
        t,
        o,
        h: Math.round((Math.max(o, c) + rng() * 0.3) * 100) / 100,
        l: Math.round((Math.min(o, c) - rng() * 0.3) * 100) / 100,
        c,
        v: Math.round(rng() * 50000 * 100) / 100,
        trades: intIn(rng, 10, 4000),
      };
      price = c;
      t += 300000;
      return row;
    });
    return { route: "candles" as const, symbol, interval: pick(rng, INTERVALS), candles };
  });
}

const FIRST = ["Ada", "Linus", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Radia", "Ken", "Margaret"];
const LAST = ["Hopper", "Torvalds", "Lovelace", "Turing", "Dijkstra", "Liskov", "Knuth", "Perlman", "Thompson", "Hamilton"];
const LEXICON = (
  "the of and to in is that it was for on are as with his they at be this have from or had by hot word " +
  "but what some we can out other were all there when up use your how said an each she which do their time " +
  "deploy latency cluster rollout incident postmortem throughput regression release migration schema payload"
).split(" ");

/** GET /v1/feed — a page of posts from a recurring cast of authors. */
export function feedCorpus(count: number, seed: number): z.output<typeof FeedResponse>[] {
  const rng = mulberry32(seed);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join("");
  const authors = Array.from({ length: 120 }, (_, i) => {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
    return {
      id: hex(12),
      name: `${first} ${last}`,
      handle: `@${first.toLowerCase()}${last.toLowerCase()}${i}`,
      verified: rng() < 0.2,
    };
  });
  const base = 1754500000000;

  return Array.from({ length: count }, () => ({
    route: "feed" as const,
    posts: Array.from({ length: intIn(rng, 10, 25) }, () => {
      const sentences = Array.from({ length: intIn(rng, 1, 3) }, () => {
        const words = Array.from({ length: intIn(rng, 8, 24) }, () => pick(rng, LEXICON));
        const s = words.join(" ");
        return s.charAt(0).toUpperCase() + s.slice(1) + ".";
      });
      return {
        id: hex(16),
        author: authors[zipfIndex(rng, authors.length)]!,
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
}

export { CandleResponse, DeviceResponse, FeedResponse };
