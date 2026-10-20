import { checkedOptions, compileIR, HEADER_SIZE, MAGIC, WIRE_VERSION, type Codec, type PackHooks } from "./codec.js";
import { DecodeError, EncodeError, FingerprintMismatchError, HyperflyError } from "./errors.js";
import type { IRNode } from "./ir.js";
import { MAX_ARTIFACT_NESTING } from "./nesting.js";
import type { Profile, SharedProfile } from "./profile.js";
import type { DecodeLimits } from "./reader.js";
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
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

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

function jsonBody(value: unknown): string {
  let body: string | undefined;
  try {
    body = JSON.stringify(value);
  } catch (cause) {
    throw new EncodeError("json", `$: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (body === undefined) throw new EncodeError("json", "$: value has no JSON representation");
  return body;
}

/** Encode one value according to a negotiation decision. */
export function encodeFor<T>(decision: Negotiation<T>, value: T, options: NegotiateOptions = {}): Encoded {
  if (decision.kind === "hyperfly") {
    try {
      return { body: decision.codec.encode(value), headers: decision.headers };
    } catch (error) {
      if (!(error instanceof EncodeError) || (error.code !== "limit" && error.code !== "depth")) throw error;
      options.onFallback?.(error);
      return {
        body: jsonBody(value),
        headers: {
          Vary: VARY,
          "Content-Type": "application/json",
          "Hyperfly-Offer": decision.codec.fingerprint,
        },
      };
    }
  }
  return { body: jsonBody(value), headers: decision.headers };
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

export interface LoadArtifactOptions {
  limits?: Partial<DecodeLimits>;
  pack?: PackHooks | false;
}

function checkedFingerprint(fingerprint: string): string {
  if (fingerprint.length !== 32 || !/^[0-9a-f]{32}$/i.test(fingerprint)) {
    throw new HyperflyError("fingerprint", "invalid artifact fingerprint");
  }
  return fingerprint.toLowerCase();
}

function checkNesting(value: unknown): void {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (depth > MAX_ARTIFACT_NESTING) throw new HyperflyError("ir", `artifact nests deeper than ${MAX_ARTIFACT_NESTING}`);
    for (const inner of Object.values(node)) stack.push([inner, depth + 1]);
  }
}

function artifactRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HyperflyError("ir", `${path}: must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new HyperflyError("ir", `${path}: unknown key ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new HyperflyError("ir", `${path}: missing key ${key}`);
  }
  return value as Record<string, unknown>;
}

/** Compile parsed artifact content and verify its fingerprint (negotiation §3). */
export function loadArtifact<T = unknown>(text: string, fingerprint: string, options: LoadArtifactOptions = {}): Codec<T> {
  const expected = checkedFingerprint(fingerprint);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new HyperflyError("json", `artifact is not JSON: ${error.message}`, { cause: error });
    throw error;
  }
  checkNesting(parsed);
  const root = artifactRecord(parsed, "$", ["wire", "plan", "ir"], ["profile"]);
  if (root.wire !== 1) throw new HyperflyError("ir", "$.wire: must be 1");
  const plan = artifactRecord(root.plan, "$.plan", ["layout", "version"]);
  if (plan.layout !== "row" && plan.layout !== "columnar") {
    throw new HyperflyError("ir", "$.plan.layout: must be row or columnar");
  }
  if (typeof plan.version !== "number") throw new HyperflyError("ir", "$.plan.version: must be a number");
  let profile: Profile | undefined;
  if (Object.prototype.hasOwnProperty.call(root, "profile")) {
    const shared = root.profile as SharedProfile | null;
    const version = Array.isArray(shared?.columns)
      && shared.columns.some((column) => column && (column.grammar || column.derived)) ? 2 : 1;
    profile = { version, shared: shared as SharedProfile };
  }
  const { limits, pack } = checkedOptions(options);
  let codec: Codec<T>;
  try {
    codec = compileIR<T>(root.ir as IRNode, { plan: plan.layout, profile, limits, pack });
  } catch (error) {
    if (error instanceof HyperflyError) throw error;
    throw new HyperflyError("ir", `artifact does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
  const compiled = JSON.parse(codec.artifact) as { plan: { version: number } };
  if (compiled.plan.version !== plan.version) {
    throw new HyperflyError("ir", `$.plan.version: ${plan.layout} is version ${compiled.plan.version} in this build`);
  }
  if (codec.fingerprint !== expected) throw new FingerprintMismatchError(expected, codec.fingerprint);
  return codec;
}

export interface FetchArtifactOptions extends LoadArtifactOptions {
  fetch?: typeof fetch;
  headers?: HeadersInit;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Fetch and verify an offered artifact. 404 is a miss; another non-2xx status throws code "fingerprint"; network errors and aborts propagate. */
export async function fetchArtifact<T = unknown>(
  base: string | URL,
  fingerprint: string,
  options: FetchArtifactOptions = {},
): Promise<Codec<T> | undefined> {
  const fp = checkedFingerprint(fingerprint);
  const maxBytes = bodyLimit(options.maxBytes);
  const response = await (options.fetch ?? globalThis.fetch)(new URL(WELL_KNOWN_PREFIX + fp, base), {
    method: "GET",
    headers: options.headers,
    signal: options.signal,
  });
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    if (response.status === 404) return undefined;
    throw new HyperflyError("fingerprint", `artifact fetch failed with status ${response.status}`);
  }
  const result = await readLimited(response.body, maxBytes);
  if (!result.ok) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (result.status === 413) throw new HyperflyError("limit", `artifact exceeds maxBytes ${maxBytes}`);
    throw new HyperflyError("ir", "artifact body could not be read");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch {
    throw new HyperflyError("ir", "artifact is not valid UTF-8");
  }
  return loadArtifact<T>(text, fp, options);
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
    let text: string;
    try {
      text = typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch (cause) {
      throw new DecodeError("json", "$: body is not valid UTF-8", { cause });
    }
    try {
      return { kind: "json", value: JSON.parse(text) as T };
    } catch (cause) {
      if (cause instanceof SyntaxError) throw new DecodeError("json", `$: ${cause.message}`, { cause });
      throw cause;
    }
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
  const status = options.status ?? 200;
  const bodyless = request.method === "HEAD" || NULL_BODY_STATUSES.has(status);
  const { body, headers } = bodyless && value === undefined
    ? { body: null, headers: decision.headers }
    : encodeFor(decision, value, options);
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
  return new Response(bodyless ? null : body as BodyInit, { status, headers: responseHeaders });
}

/**
 * Artifact discovery as a Response, or undefined when the path is not ours — so a
 * caller can chain it ahead of its own router in one line.
 */
export function discovery(request: Request, registry: CodecRegistry): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const served = serveArtifact(new URL(request.url).pathname, registry);
  if (!served) return undefined;
  const body = request.method === "HEAD" ? null : served.body || null;
  return new Response(body, { status: served.status, headers: served.headers });
}

export interface ReadBodyOptions {
  maxBytes?: number;
}

/** Read a hyperfly or JSON request body (negotiation §4). */
export async function readBody<T>(
  request: Request,
  registry: CodecRegistry,
  options: ReadBodyOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  return readBodyWithinLimit<T>(request, registry, bodyLimit(options.maxBytes));
}

function bodyLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new HyperflyError("options", "maxBytes: must be a non-negative safe integer");
  }
  return maxBytes;
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
  const result = await readLimited(request.body, maxBytes);
  if (!result.ok) return { ok: false, response: new Response(null, { status: result.status }) };
  const bytes = result.bytes;
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

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (stream !== null) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = stream.getReader();
    } catch {
      return { ok: false, status: 400 };
    }
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
          return { ok: false, status: 413 };
        }
        if (value.byteLength > 0) chunks.push(new Uint8Array(value));
      }
    } catch {
      return { ok: false, status: 400 };
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
  return { ok: true, bytes };
}
