export type Strategy = "geo" | "random";

export interface Origin {
  url: string;
  regions?: string[];
  write?: boolean;
}

export interface LBConfig {
  origins: (string | Origin)[];
  strategy?: Strategy;
}

function normalizeOrigins(origins: LBConfig["origins"]): Origin[] {
  return origins.map((o) => (typeof o === "string" ? { url: o } : o));
}

function pickRandom(origins: Origin[]): Origin {
  return origins[Math.floor(Math.random() * origins.length)];
}

function pickGeo(origins: Origin[], continent: string | undefined): Origin | undefined {
  if (!continent) return undefined;
  return origins.find((o) => o.regions?.includes(continent));
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

export function createLB(config: LBConfig) {
  const origins = normalizeOrigins(config.origins);
  const strategy = config.strategy ?? "geo";

  const writeOrigins = origins.filter((o) => o.write);
  const readOrigins = origins.filter((o) => !o.write);

  return {
    async fetch(request: Request): Promise<Response> {
      const pool = isWriteMethod(request.method) ? writeOrigins : readOrigins;
      const candidates = pool.length > 0 ? pool : origins;

      let origin: Origin;

      if (strategy === "geo") {
        const continent = (request as any).cf?.continent as string | undefined;
        origin = pickGeo(candidates, continent) ?? pickRandom(candidates);
      } else {
        origin = pickRandom(candidates);
      }

      const url = new URL(request.url);
      const target = new URL(origin.url);
      url.host = target.host;
      url.protocol = target.protocol;

      return fetch(new Request(url.toString(), request));
    },
  };
}
