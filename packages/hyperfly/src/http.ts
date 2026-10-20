import { HEADER_SIZE, MAGIC, WIRE_VERSION, type Codec } from "./codec.js";
import { DecodeError, EncodeError, HyperflyError } from "./errors.js";
import type { CodecRegistry } from "./registry.js";

export const HYPERFLY_MEDIA_TYPE = "application/vnd.hyperfly";
export const ACCEPT_HEADER = "hyperfly-accept";
export const CODEC_HEADER = "hyperfly-codec";
export const OFFER_HEADER = "hyperfly-offer";
export const WELL_KNOWN_PREFIX = "/.well-known/hyperfly/";
export const DEFAULT_MAX_BODY_BYTES = 1 << 20;

/** Negotiation §6: client-controlled input, so parsing is bounded. */
const MAX_ENTRIES = 32;
const FINGERPRINT = /^[0-9a-f]{32}$/;
const VARY = "Hyperfly-Accept, Accept";

/** Client fingerprints in preference order, ignoring malformed entries and duplicates. */
export function parseAccept(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  let pos = 0;
  for (let count = 0; count < MAX_ENTRIES && pos <= header.length; count++) {
    const comma = header.indexOf(",", pos);
    let start = pos;
    let end = comma === -1 ? header.length : comma;
    pos = end + 1;
    while (start < end && (header.charCodeAt(start) === 0x20 || header.charCodeAt(start) === 0x09)) start++;
    while (end > start && (header.charCodeAt(end - 1) === 0x20 || header.charCodeAt(end - 1) === 0x09)) end--;
    if (end - start !== 32) continue;
    let valid = true;
    for (let i = start; i < end; i++) {
      const code = header.charCodeAt(i);
      if (!((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const value = header.slice(start, end);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export type Negotiation<T = unknown> =
  | { kind: "hyperfly"; codec: Codec<T>; headers: Record<string, string> }
  | { kind: "json"; headers: Record<string, string> };

export interface NegotiateOptions {
  accept?: string | null;
  onFallback?: (error: EncodeError) => void;
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
  const vary = { Vary: VARY };

  if (options.enabled === false) {
    return { kind: "json", headers: { ...vary, "Content-Type": "application/json" } };
  }

  const codec = rejectsHyperfly(options.accept) ? undefined : registry.select(parseAccept(accept));
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
export function encodeFor<T>(decision: Negotiation<T>, value: T, options: NegotiateOptions = {}): Encoded {
  if (decision.kind === "hyperfly") {
    try {
      return { body: decision.codec.encode(value), headers: decision.headers };
    } catch (error) {
      if (!(error instanceof EncodeError) || error.code !== "limit") throw error;
      options.onFallback?.(error);
      return {
        body: JSON.stringify(value),
        headers: {
          Vary: VARY,
          "Content-Type": "application/json",
          "Hyperfly-Offer": decision.codec.fingerprint,
        },
      };
    }
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

function trimOws(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s.charCodeAt(start) === 0x20 || s.charCodeAt(start) === 0x09)) start++;
  while (end > start && (s.charCodeAt(end - 1) === 0x20 || s.charCodeAt(end - 1) === 0x09)) end--;
  return s.slice(start, end);
}

function mediaType(contentType: string | null | undefined): string {
  return trimOws((contentType ?? "application/json").split(";", 1)[0]!).toLowerCase();
}

function rejectsHyperfly(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let start = 0;
  let specificity = 0;
  let refused = false;
  for (let count = 0; count < MAX_ENTRIES && start <= accept.length; count++) {
    let end = start;
    let quoted = false;
    for (; end < accept.length; end++) {
      const code = accept.charCodeAt(end);
      if (quoted && code === 0x5c) end++;
      else if (code === 0x22) quoted = !quoted;
      else if (!quoted && code === 0x2c) break;
    }
    const range = accept.slice(start, end);
    start = end + 1;
    const semicolon = range.indexOf(";");
    const type = trimOws(range.slice(0, semicolon === -1 ? range.length : semicolon)).toLowerCase();
    const rank = type === HYPERFLY_MEDIA_TYPE ? 3 : type === "application/*" ? 2 : type === "*/*" ? 1 : 0;
    if (rank <= specificity) continue;
    let valid = true;
    let zero = false;
    if (semicolon !== -1) {
      const parameter = range.slice(semicolon + 1);
      const equals = parameter.indexOf("=");
      const name = trimOws(parameter.slice(0, equals)).toLowerCase();
      const value = trimOws(parameter.slice(equals + 1));
      if (equals === -1 || name !== "q" || !/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)(?![\s\S])/.test(value)) {
        valid = false;
      }
      zero = Number(value) === 0;
    }
    if (valid) {
      specificity = rank;
      refused = zero;
    }
  }
  return refused;
}

function peekFingerprint(bytes: Uint8Array): string {
  if (bytes.length < HEADER_SIZE) throw new DecodeError("header", "shorter than envelope header");
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) throw new DecodeError("header", "bad magic");
  if (bytes[2] !== WIRE_VERSION) throw new DecodeError("header", `unsupported wire major ${bytes[2]}`);
  let fingerprint = "";
  for (let i = 3; i < HEADER_SIZE; i++) fingerprint += bytes[i]!.toString(16).padStart(2, "0");
  return fingerprint;
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
  if (mediaType(contentType) !== HYPERFLY_MEDIA_TYPE) {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    return { kind: "json", value: JSON.parse(text) as T };
  }
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const fingerprint = peekFingerprint(bytes);
  const codec = registry.get(fingerprint);
  if (!codec) return { kind: "unknown-codec", fingerprint };
  return { kind: "hyperfly", value: codec.decode(bytes) as T };
}

/**
 * Fetch-API glue. One function covers Hono, Cloudflare Workers, Bun.serve, Deno and
 * Next route handlers, because they all speak Request and Response.
 */
export interface FetchHandlerOptions extends NegotiateOptions {
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
  const decision = negotiate<T>(request.headers.get(ACCEPT_HEADER), registry, {
    ...options,
    accept: options.accept === undefined ? request.headers.get("accept") : options.accept,
  });
  const { body, headers } = encodeFor(decision, value, options);
  const responseHeaders = new Headers(options.headers);
  for (const name of ["Content-Type", "Content-Length", "Hyperfly-Codec", "Hyperfly-Offer"]) {
    responseHeaders.delete(name);
  }
  const vary = new Map<string, string>();
  for (const token of `${responseHeaders.get("vary") ?? ""},${headers.Vary}`.split(",")) {
    const name = token.trim();
    if (name && !vary.has(name.toLowerCase())) vary.set(name.toLowerCase(), name);
  }
  for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
  responseHeaders.set("Vary", [...vary.values()].join(", "));
  return new Response(body as BodyInit, {
    status: options.status ?? 200,
    headers: responseHeaders,
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

export interface ReadBodyOptions {
  maxBytes?: number;
}

/** Read a hyperfly or JSON request body (negotiation §4). */
export function readBody<T>(
  request: Request,
  registry: CodecRegistry,
  options: ReadBodyOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  return readBodyWithinLimit<T>(request, registry, maxBytes);
}

async function readBodyWithinLimit<T>(
  request: Request,
  registry: CodecRegistry,
  maxBytes: number,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const contentType = mediaType(request.headers.get("content-type"));
  const isHyperfly = contentType === HYPERFLY_MEDIA_TYPE;
  const isJson = contentType === "application/json"
    || /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+\+json(?![\s\S])/.test(contentType);
  if (!isHyperfly && !isJson) {
    return { ok: false, response: new Response(null, { status: 415 }) };
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength.trim()) && Number(contentLength) > maxBytes) {
    return { ok: false, response: new Response(null, { status: 413 }) };
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          try {
            reader.cancel().catch(() => {});
          } catch {
            // Cancellation is best effort.
          }
          return { ok: false, response: new Response(null, { status: 413 }) };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, response: new Response(null, { status: 400 }) };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Stream cleanup must not replace the response.
      }
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isHyperfly) {
    try {
      return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T };
    } catch {
      return { ok: false, response: new Response(null, { status: 400 }) };
    }
  }
  try {
    const fingerprint = peekFingerprint(bytes);
    const codecHeader = request.headers.get(CODEC_HEADER);
    if (codecHeader !== null && trimOws(codecHeader) !== fingerprint) {
      return { ok: false, response: new Response(null, { status: 400 }) };
    }
    const codec = registry.get(fingerprint);
    if (!codec) {
      const offer = registry.fingerprints[0];
      return {
        ok: false,
        response: new Response(null, {
          status: 415,
          headers: offer ? { "Hyperfly-Offer": offer } : {},
        }),
      };
    }
    return { ok: true, value: codec.decode(bytes) as T };
  } catch (error) {
    if (error instanceof HyperflyError) return { ok: false, response: new Response(null, { status: 400 }) };
    throw error;
  }
}
