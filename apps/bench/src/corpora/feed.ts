import { z } from "zod";
import { intIn, mulberry32, pick } from "../prng.js";

export const FeedResponse = z.object({
  route: z.literal("feed"),
  posts: z.array(
    z.object({
      id: z.string(),
      author: z.object({
        id: z.string(),
        name: z.string(),
        handle: z.string(),
        verified: z.boolean(),
      }),
      body: z.string(),
      lang: z.enum(["en", "de", "fr", "es", "ja"]),
      likes: z.number().int().min(0),
      replies: z.number().int().min(0),
      reposts: z.number().int().min(0),
      createdAt: z.number().int().min(0),
      inReplyTo: z.string().nullable(),
    }),
  ),
});

const LEXICON = (
  "the of and to in is that it was for on are as with his they at be this have from or had by hot word " +
  "but what some we can out other were all there when up use your how said an each she which do their time " +
  "if will way about many then them write would like so these her long make thing see him two has look more " +
  "day could go come did number sound no most people my over know water than call first who may down side " +
  "been now find any new work part take get place made live where after back little only round man year came " +
  "show every good me give our under name very through just form sentence great think say help low line differ " +
  "turn cause much mean before move right boy old too same tell does set three want air well also play small " +
  "end put home read hand port large spell add even land here must big high such follow act why ask men change " +
  "went light kind off need house picture try us again animal point mother world near build self earth father"
).split(" ");

const FIRST = ["Ada", "Linus", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Radia", "Ken", "Margaret"];
const LAST = ["Hopper", "Torvalds", "Lovelace", "Turing", "Dijkstra", "Liskov", "Knuth", "Perlman", "Thompson", "Hamilton"];

function sentence(rng: () => number, words: number): string {
  const parts = Array.from({ length: words }, () => pick(rng, LEXICON));
  const s = parts.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function hexId(rng: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

export function feedPayload(count: number, seed: number): z.output<typeof FeedResponse> {
  const rng = mulberry32(seed);
  const posts = [];
  const base = 1754500000000;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const first = pick(rng, FIRST);
    const last = pick(rng, LAST);
    const id = hexId(rng, 16);
    const body = Array.from({ length: intIn(rng, 1, 4) }, () => sentence(rng, intIn(rng, 8, 28))).join(" ");
    posts.push({
      id,
      author: {
        id: hexId(rng, 12),
        name: `${first} ${last}`,
        handle: `@${first.toLowerCase()}${last.toLowerCase()}${intIn(rng, 1, 99)}`,
        verified: rng() < 0.2,
      },
      body,
      lang: pick(rng, ["en", "en", "en", "de", "fr", "es", "ja"] as const),
      likes: intIn(rng, 0, 50000),
      replies: intIn(rng, 0, 2000),
      reposts: intIn(rng, 0, 8000),
      createdAt: base - intIn(rng, 0, 604800000),
      inReplyTo: rng() < 0.3 && ids.length > 0 ? pick(rng, ids) : null,
    });
    ids.push(id);
  }
  return { route: "feed", posts };
}
