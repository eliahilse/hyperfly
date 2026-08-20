import type { Codec } from "./codec.js";
import type { CodecRegistry } from "./registry.js";

export const HYPERFLY_MEDIA_TYPE = "application/vnd.hyperfly";
export const ACCEPT_HEADER = "hyperfly-accept";
export const CODEC_HEADER = "hyperfly-codec";
export const OFFER_HEADER = "hyperfly-offer";
export const WELL_KNOWN_PREFIX = "/.well-known/hyperfly/";

/** Negotiation §6: client-controlled input, so parsing is bounded. */
const MAX_ACCEPTED = 32;
const FINGERPRINT = /^[0-9a-f]{32}$/;

/**
 * Fingerprints the client says it can decode, in its order of preference.
 * Malformed entries are dropped rather than failing the request.
 */
export function parseAccept(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(",")) {
    if (out.length >= MAX_ACCEPTED) break;
    const value = part.trim().toLowerCase();
    if (FINGERPRINT.test(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

export type Negotiation<T = unknown> =
  | { kind: "hyperfly"; codec: Codec<T>; headers: Record<string, string> }
  | { kind: "json"; headers: Record<string, string> };

export interface NegotiateOptions {
  /** Named in Hyperfly-Offer when falling back, so a client can upgrade itself. */
  offer?: string;
  /** An operator switch or a load shed: fall back without consulting the registry. */
  enabled?: boolean;
}

/**
 * Decide how to answer one request. Framework-agnostic on purpose: everything a
 * server needs is the Hyperfly-Accept header and a registry.
 *
 * Vary is always set, because the same URL yields either representation and a
 * shared cache would otherwise hand one peer's binary to a peer that cannot read it.
 */
export function negotiate<T = unknown>(
  accept: string | null | undefined,
  registry: CodecRegistry,
  options: NegotiateOptions = {},
): Negotiation<T> {
  const vary = { Vary: "Hyperfly-Accept" };

  if (options.enabled === false) {
    return { kind: "json", headers: { ...vary, "Content-Type": "application/json" } };
  }

  const codec = registry.select(parseAccept(accept));
  if (codec) {
    return {
      kind: "hyperfly",
      codec: codec as unknown as Codec<T>,
      headers: {
        ...vary,
        "Content-Type": HYPERFLY_MEDIA_TYPE,
        "Hyperfly-Codec": codec.fingerprint,
      },
    };
  }

  const offer = options.offer ?? registry.fingerprints[0];
  return {
    kind: "json",
    headers: {
      ...vary,
      "Content-Type": "application/json",
      ...(offer ? { "Hyperfly-Offer": offer } : {}),
    },
  };
}

export interface Encoded {
  body: Uint8Array | string;
  headers: Record<string, string>;
}

/** Encode one value according to a negotiation decision. */
export function encodeFor<T>(decision: Negotiation<T>, value: T): Encoded {
  if (decision.kind === "hyperfly") {
    return { body: decision.codec.encode(value), headers: decision.headers };
  }
  return { body: JSON.stringify(value), headers: decision.headers };
}

export interface WellKnownResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Serve `.well-known/hyperfly/{fingerprint}` (negotiation §3). Artifacts are
 * content-addressed, so a hit is immutable and cacheable forever; a miss is a 404
 * and not an error — the client simply stays on JSON.
 */
export function serveArtifact(pathname: string, registry: CodecRegistry): WellKnownResponse | undefined {
  if (!pathname.startsWith(WELL_KNOWN_PREFIX)) return undefined;
  const fingerprint = pathname.slice(WELL_KNOWN_PREFIX.length).toLowerCase();
  if (!FINGERPRINT.test(fingerprint)) {
    return { status: 404, body: "", headers: { "Cache-Control": "no-store" } };
  }
  const artifact = registry.artifact(fingerprint);
  if (!artifact) {
    return { status: 404, body: "", headers: { "Cache-Control": "no-store" } };
  }
  return {
    status: 200,
    body: artifact,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  };
}

/** The header a client sends. Preference order is the caller's. */
export function acceptHeader(fingerprints: readonly string[]): string {
  return fingerprints.join(", ");
}

/**
 * Decode a response body according to what the server said it sent. A codec the
 * client does not hold is not an error the client can recover from by guessing,
 * so it is reported as a miss and the caller re-requests as JSON.
 */
export function decodeResponse<T>(
  contentType: string | null | undefined,
  body: Uint8Array | string,
  registry: CodecRegistry,
): { kind: "json"; value: T } | { kind: "hyperfly"; value: T } | { kind: "unknown-codec"; fingerprint: string } {
  const isHyperfly = (contentType ?? "").toLowerCase().startsWith(HYPERFLY_MEDIA_TYPE);
  if (!isHyperfly) {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return { kind: "json", value: JSON.parse(text) as T };
  }
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let fingerprint = "";
  for (let i = 3; i < 19 && i < bytes.length; i++) fingerprint += bytes[i]!.toString(16).padStart(2, "0");
  const codec = registry.get(fingerprint);
  if (!codec) return { kind: "unknown-codec", fingerprint };
  return { kind: "hyperfly", value: codec.decode(bytes) as T };
}

/**
 * Fetch-API glue. One function covers Hono, Cloudflare Workers, Bun.serve, Deno and
 * Next route handlers, because they all speak Request and Response.
 */
export interface FetchHandlerOptions extends NegotiateOptions {
  /** Also answer .well-known artifact discovery. On by default (negotiation §3). */
  discovery?: boolean;
  status?: number;
  headers?: Record<string, string>;
}

/** Answer one request with `value`, in binary when the client can read it. */
export function respond<T>(
  request: Request,
  value: T,
  registry: CodecRegistry,
  options: FetchHandlerOptions = {},
): Response {
  const decision = negotiate<T>(request.headers.get(ACCEPT_HEADER), registry, options);
  const { body, headers } = encodeFor(decision, value);
  return new Response(body as BodyInit, {
    status: options.status ?? 200,
    headers: { ...headers, ...options.headers },
  });
}

/**
 * Artifact discovery as a Response, or undefined when the path is not ours — so a
 * caller can chain it ahead of its own router in one line.
 */
export function discovery(request: Request, registry: CodecRegistry): Response | undefined {
  const served = serveArtifact(new URL(request.url).pathname, registry);
  if (!served) return undefined;
  return new Response(served.body || null, { status: served.status, headers: served.headers });
}

/** Read a hyperfly or JSON request body (negotiation §4). */
export async function readBody<T>(
  request: Request,
  registry: CodecRegistry,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type");
  if (!(contentType ?? "").toLowerCase().startsWith(HYPERFLY_MEDIA_TYPE)) {
    return { ok: true, value: (await request.json()) as T };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const decoded = decodeResponse<T>(contentType, bytes, registry);
  if (decoded.kind === "unknown-codec") {
    // a body already sent in a format we cannot read has no safe fallback
    return {
      ok: false,
      response: new Response(null, {
        status: 415,
        headers: {
          ...(registry.fingerprints[0] ? { "Hyperfly-Offer": registry.fingerprints[0] } : {}),
        },
      }),
    };
  }
  return { ok: true, value: decoded.value };
}
