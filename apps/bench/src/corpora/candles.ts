import { z } from "zod";
import { intIn, mulberry32 } from "../prng.js";

export const CandleResponse = z.object({
  route: z.literal("candles"),
  symbol: z.string(),
  interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]),
  candles: z.array(
    z.object({
      t: z.number().int().min(0),
      o: z.number(),
      h: z.number(),
      l: z.number(),
      c: z.number(),
      v: z.number().min(0),
      trades: z.number().int().min(0),
    }),
  ),
});

export function candlesPayload(rows: number, seed: number): z.output<typeof CandleResponse> {
  const rng = mulberry32(seed);
  const candles = [];
  let t = 1735689600000;
  let price = 104.25;
  for (let i = 0; i < rows; i++) {
    const o = price;
    const drift = (rng() - 0.5) * 0.8;
    const c = Math.round((o + drift) * 100) / 100;
    const h = Math.round((Math.max(o, c) + rng() * 0.3) * 100) / 100;
    const l = Math.round((Math.min(o, c) - rng() * 0.3) * 100) / 100;
    candles.push({
      t,
      o,
      h,
      l,
      c,
      v: Math.round(rng() * 50000 * 100) / 100,
      trades: intIn(rng, 10, 4000),
    });
    price = c;
    t += 300000;
  }
  return { route: "candles", symbol: "HFLY-USD", interval: "5m", candles };
}
