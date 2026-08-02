export type Strategy = "geo" | "random";

export interface Origin {
  url: string;
  regions?: string[];
  write?: boolean;
}

export interface FailoverConfig {
  maxRetries?: number;
  statusCodes?: number[];
  timeout?: number;
}

export interface HyperflyConfig {
  origins: (string | Origin)[];
  strategy?: Strategy;
  failover?: FailoverConfig | boolean;
}

function normalizeOrigins(origins: HyperflyConfig["origins"]): Origin[] {
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

const DEFAULT_FAILOVER_CODES = [429, 500, 502, 503, 504];

function shouldFailover(status: number, codes: number[]): boolean {
  return codes.includes(status);
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildFailoverQueue(
  primary: Origin,
  candidates: Origin[],
  maxRetries: number
): Origin[] {
  const others = shuffle(candidates.filter((o) => o.url !== primary.url));
  return [primary, ...others].slice(0, maxRetries);
}

function proxyRequest(request: Request, origin: Origin, timeout?: number): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(origin.url);
  url.host = target.host;
  url.protocol = target.protocol;

  const proxied = new Request(url.toString(), request);

  if (!timeout) return fetch(proxied);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  return fetch(proxied, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

export class Hyperfly {
  private origins: Origin[];
  private strategy: Strategy;
  private failoverEnabled: boolean;
  private maxRetries: number;
  private failoverCodes: number[];
  private timeout?: number;
  private writeOrigins: Origin[];
  private readOrigins: Origin[];

  constructor(config: HyperflyConfig) {
    this.origins = normalizeOrigins(config.origins);
    this.strategy = config.strategy ?? "geo";
    this.failoverEnabled = config.failover !== undefined && config.failover !== false;

    const failoverConfig = typeof config.failover === "object" ? config.failover : {};
    this.maxRetries = failoverConfig.maxRetries ?? this.origins.length;
    this.failoverCodes = failoverConfig.statusCodes ?? DEFAULT_FAILOVER_CODES;
    this.timeout = failoverConfig.timeout;

    this.writeOrigins = this.origins.filter((o) => o.write);
    this.readOrigins = this.origins.filter((o) => !o.write);
  }

  async fetch(request: Request): Promise<Response> {
    const pool = isWriteMethod(request.method) ? this.writeOrigins : this.readOrigins;
    const candidates = pool.length > 0 ? pool : this.origins;

    const continent = (request as any).cf?.continent as string | undefined;
    const primary =
      this.strategy === "geo"
        ? pickGeo(candidates, continent) ?? pickRandom(candidates)
        : pickRandom(candidates);

    if (!this.failoverEnabled) {
      return proxyRequest(request, primary, this.timeout);
    }

    const failoverPool =
      isWriteMethod(request.method) && this.writeOrigins.length > 0
        ? this.writeOrigins
        : candidates;
    const queue = buildFailoverQueue(primary, failoverPool, this.maxRetries);

    let lastError: unknown;
    for (const origin of queue) {
      try {
        const response = await proxyRequest(request, origin, this.timeout);
        if (!shouldFailover(response.status, this.failoverCodes)) {
          return response;
        }
        lastError = response;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError instanceof Response) return lastError;
    throw lastError;
  }
}
