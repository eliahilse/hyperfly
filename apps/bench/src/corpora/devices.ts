import { z } from "zod";
import { intIn, mulberry32, pick } from "../prng.js";

export const DeviceResponse = z.object({
  route: z.literal("devices"),
  page: z.number().int().min(0),
  devices: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["online", "offline", "degraded", "provisioning", "decommissioned", "unknown"]),
      region: z.enum(["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"]),
      battery: z.number().int().min(0).max(100),
      rssi: z.number().int().min(-120).max(0),
      uptimeSec: z.number().int().min(0),
      tempC: z.number(),
      firmwareMajor: z.number().int().min(0).max(30),
      firmwareMinor: z.number().int().min(0).max(99),
      alarms: z.number().int().min(0).max(50),
      shadowSynced: z.boolean(),
      lastSeen: z.number().int().min(0),
      tag: z.string().nullable(),
    }),
  ),
});

const TAGS = ["fleet-a", "fleet-b", "pilot", "lab", null, null, null];

export function devicesPayload(count: number, seed: number): z.output<typeof DeviceResponse> {
  const rng = mulberry32(seed);
  const devices = [];
  const base = 1754000000000;
  for (let i = 0; i < count; i++) {
    devices.push({
      id: `dev-${String(intIn(rng, 0, 9999)).padStart(4, "0")}-${String(i).padStart(5, "0")}`,
      status: pick(rng, ["online", "online", "online", "online", "offline", "degraded", "provisioning", "unknown"] as const),
      region: pick(rng, ["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast", "sa-east", "af-south"] as const),
      battery: intIn(rng, 0, 100),
      rssi: intIn(rng, -120, 0),
      uptimeSec: intIn(rng, 0, 40000000),
      tempC: Math.round((15 + rng() * 45) * 10) / 10,
      firmwareMajor: intIn(rng, 1, 4),
      firmwareMinor: intIn(rng, 0, 27),
      alarms: rng() < 0.85 ? 0 : intIn(rng, 1, 12),
      shadowSynced: rng() < 0.93,
      lastSeen: base - intIn(rng, 0, 86400000),
      tag: pick(rng, TAGS),
    });
  }
  return { route: "devices", page: 0, devices };
}
