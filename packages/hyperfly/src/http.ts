import { checkedOptions, compileIR, HEADER_SIZE, MAGIC, WIRE_VERSION, type Codec, type PackHooks } from "./codec.js";
import { DecodeError, EncodeError, FingerprintMismatchError, HyperflyError, isInstance, messageOf } from "./errors.js";
import type { IRNode } from "./ir.js";
import { MAX_ARTIFACT_NESTING } from "./nesting.js";
import type { Profile, SharedProfile } from "./profile.js";
import type { Limits } from "./reader.js";
import type { CodecRegistry } from "./registry.js";
import { byteLengthOf, isUint8Array } from "./typed-array.js";
import { INT_MAX, INT_MIN } from "./varint.js";

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

/** Why a response is JSON rather than binary. `encoder-limit` comes from `encodeFor`, the others from `negotiate`. */
export type FallbackReason = "disabled" | "accept-refused" | "no-hyperfly-accept" | "no-match" | "encoder-limit";

/** `negotiate` chose a codec: encode with it and send `headers`. */
export interface HyperflyNegotiation<T = unknown> {
  kind: "hyperfly";
  codec: Codec<T>;
  headers: Record<string, string>;
}

/** `negotiate` chose JSON; `reason` says why. */
export interface JsonNegotiation {
  kind: "json";
  headers: Record<string, string>;
  reason: Exclude<FallbackReason, "encoder-limit">;
}

/** The decision `negotiate` returns: binary with a codec, or JSON with a reason. */
export type Negotiation<T = unknown> = HyperflyNegotiation<T> | JsonNegotiation;

/** What `negotiate` reads besides Hyperfly-Accept. */
export interface NegotiateOptions {
  /** The HTTP Accept header; a q=0 for binary forces JSON. Default: none (`respond` reads the request's). */
  httpAccept?: string | null;
  /** Named in Hyperfly-Offer when falling back, so a client can upgrade itself. Default: the registry's first fingerprint. */
  offer?: string;
  /** An operator switch or a load shed: `false` falls back without consulting the registry. Default: `true`. */
  enabled?: boolean;
}

/** What `encodeFor` reads. */
export interface EncodeOptions {
  /** Called when the codec refuses a value under its limits and the value goes out as JSON. Default: none. */
  onFallback?: (error: EncodeError, reason: "encoder-limit") => void;
}

/**
 * Decide how to answer one request. Framework-agnostic on purpose: everything a
 * server needs is the Hyperfly-Accept header and a registry.
 *
 * Vary is always set, because the same URL yields either representation and a
 * shared cache would otherwise hand one peer's binary to a peer that cannot read it.
 */
export function negotiate<T>(
  accept: string | null | undefined,
  registry: CodecRegistry<T>,
  options: NegotiateOptions = {},
): Negotiation<T> {
  const vary = { Vary: VARY };

  if (options.enabled === false) {
    return jsonDecision(registry, { kind: "json", headers: { ...vary, "Content-Type": "application/json" }, reason: "disabled" });
  }

  const refused = rejectsHyperfly(options.httpAccept);
  const codec = refused ? undefined : registry.select(parseAccept(accept));
  if (codec) {
    return {
      kind: "hyperfly",
      codec,
      headers: {
        ...vary,
        "Content-Type": HYPERFLY_MEDIA_TYPE,
        "Hyperfly-Codec": codec.fingerprint,
      },
    };
  }

  const offer = options.offer ?? registry.fingerprints[0];
  return jsonDecision(registry, {
    kind: "json",
    headers: {
      ...vary,
      "Content-Type": "application/json",
      ...(offer ? { "Hyperfly-Offer": offer } : {}),
    },
    reason: refused ? "accept-refused" : accept ? "no-match" : "no-hyperfly-accept",
  });
}

export interface Encoded {
  body: Uint8Array | string;
  headers: Record<string, string>;
}

type JsonDecoder = (value: unknown, path: string) => unknown;
interface JsonModel {
  hasBytes: boolean;
  decode: JsonDecoder;
}

// Codec IR is immutable. Cache JSON metadata separately so binary operations do no JSON work.
const jsonModels = new WeakMap<Codec, JsonModel>();
// Keep the JSON encoding model without changing the public negotiation decision.
const jsonEncodingCodecs = new WeakMap<JsonNegotiation, Codec>();

function jsonDecision(registry: CodecRegistry, decision: JsonNegotiation): JsonNegotiation {
  const first = registry.get(registry.fingerprints[0] ?? "");
  if (first) jsonEncodingCodecs.set(decision, first);
  return decision;
}


function jsonFailure(path: string, message: string): never {
  throw new DecodeError("json", `${path}: ${message}`);
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function jsonModel(codec: Codec): JsonModel {
  const cached = jsonModels.get(codec);
  if (cached) return cached;
  let hasBytes = false;
  function decoder(node: IRNode): JsonDecoder {
    switch (node.kind) {
      case "bytes":
        hasBytes = true;
        return (value, path) => {
          if (typeof value !== "string") return jsonFailure(path, "expected a base64 string");
          let raw: string;
          try {
            raw = atob(value);
          } catch (cause) {
            throw new DecodeError("json", `${path}: expected canonical padded base64`, { cause });
          }
          if (btoa(raw) !== value) return jsonFailure(path, "expected canonical padded base64");
          return Uint8Array.from(raw, (char) => char.charCodeAt(0));
        };
      case "nullable": {
        const inner = decoder(node.inner);
        return (value, path) => value === null ? null : inner(value, path);
      }
      case "array": {
        const element = decoder(node.element);
        return (value, path) => {
          if (!Array.isArray(value)) return jsonFailure(path, "expected array");
          if (node.length !== undefined && value.length !== node.length) return jsonFailure(path, "array length does not match declared length");
          for (let i = 0; i < value.length; i++) value[i] = element(value[i], `${path}[${i}]`);
          return value;
        };
      }
      case "struct": {
        const fields = node.fields.map((field) => ({ ...field, decode: decoder(field.type) }));
        return (value, path) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return jsonFailure(path, "expected object");
          const input = value as Record<string, unknown>;
          const output: Record<string, unknown> = {};
          for (const field of fields) {
            const fieldPath = `${path}.${field.name}`;
            if (!Object.prototype.hasOwnProperty.call(input, field.name)) {
              if (!field.optional) return jsonFailure(fieldPath, "missing required field");
              continue;
            }
            const item = input[field.name];
            output[field.name] = field.nullable && item === null ? null : field.decode(item, fieldPath);
          }
          return output;
        };
      }
      case "enum": {
        const members = new Set(node.members);
        return (value, path) => {
          if (typeof value !== "string") return jsonFailure(path, "expected string");
          if (!members.has(value)) return jsonFailure(path, "unknown enum member");
          return value;
        };
      }
      default:
        return (value, path) => {
          switch (node.kind) {
            case "bool":
              if (typeof value !== "boolean") return jsonFailure(path, "expected boolean");
              break;
            case "int":
              if (typeof value !== "number" || !Number.isSafeInteger(value) || value < INT_MIN || value > INT_MAX) {
                return jsonFailure(path, "expected integral number in the safe integer domain");
              }
              if ((node.min !== undefined && value < node.min) || (node.max !== undefined && value > node.max)) {
                return jsonFailure(path, "integer outside declared bounds");
              }
              break;
            case "float64":
              if (typeof value !== "number" || !Number.isFinite(value)) return jsonFailure(path, "expected finite float64");
              break;
            case "string":
              if (typeof value !== "string") return jsonFailure(path, "expected string");
              break;
            case "literal":
              if (value !== node.value) return jsonFailure(path, "literal mismatch");
              break;
          }
          return value;
        };
    }
  }
  const decode = decoder(codec.ir);
  const model = { hasBytes, decode };
  jsonModels.set(codec, model);
  return model;
}

/** JSON.stringify owns traversal and toJSON behavior; only declared bytes positions change. */
function jsonReplacer(ir: IRNode) {
  const parents = new WeakMap<object, IRNode>();
  let root = true;
  return function (this: object, key: string, value: unknown): unknown {
    let node: IRNode | undefined;
    if (root) {
      root = false;
      node = ir;
    } else {
      const parent = parents.get(this);
      node = parent?.kind === "array" ? parent.element
        : parent?.kind === "struct" ? parent.fields.find((field) => field.name === key)?.type : undefined;
    }
    while (node?.kind === "nullable") node = node.inner;
    if (node?.kind === "bytes") {
      // Buffer and byte subclasses can have toJSON methods, which run before the replacer.
      const bytes: unknown = isUint8Array(value) ? value : Reflect.get(this, key);
      if (isUint8Array(bytes)) return base64(bytes);
    }
    if (value !== null && typeof value === "object") {
      if (node) parents.set(value, node);
      else parents.delete(value);
    }
    return value;
  };
}

function parseJson<T>(text: string, registry: CodecRegistry<T>): T {
  const value: unknown = JSON.parse(text);
  const codec = registry.get(registry.fingerprints[0] ?? "");
  if (!codec) return value as T;
  try {
    return jsonModel(codec).decode(value, "$") as T;
  } catch (cause) {
    if (isInstance(cause, DecodeError) && cause.code === "json") throw cause;
    throw new DecodeError("json", "$: JSON value could not be converted under the codec", { cause });
  }
}

function jsonBody(value: unknown, codec?: Codec): string {
  let body: string | undefined;
  try {
    body = JSON.stringify(value, codec && jsonModel(codec).hasBytes ? jsonReplacer(codec.ir) : undefined);
  } catch (cause) {
    throw new EncodeError("json", `$: ${messageOf(cause, "value could not be encoded as JSON")}`, { cause });
  }
  if (body === undefined) throw new EncodeError("json", "$: value has no JSON representation");
  return body;
}

/**
 * Encode one value according to a negotiation decision. JSON decisions returned
 * by `negotiate` retain the first registered codec for bytes representation.
 */
export function encodeFor<T>(decision: Negotiation<T>, value: T, options: EncodeOptions = {}): Encoded {
  if (decision.kind === "hyperfly") {
    try {
      return { body: decision.codec.encode(value), headers: decision.headers };
    } catch (error) {
      if (!isInstance(error, EncodeError) || (error.code !== "limit" && error.code !== "depth")) throw error;
      options.onFallback?.(error, "encoder-limit");
      return {
        body: jsonBody(value, decision.codec),
        headers: {
          Vary: VARY,
          "Content-Type": "application/json",
          "Hyperfly-Offer": decision.codec.fingerprint,
        },
      };
    }
  }
  return { body: jsonBody(value, jsonEncodingCodecs.get(decision)), headers: decision.headers };
}

/** A `.well-known/hyperfly/{fingerprint}` answer: status, artifact text (empty on a miss) and headers. */
export interface ArtifactResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Serve `.well-known/hyperfly/{fingerprint}` (negotiation §3). Artifacts are
 * content-addressed, so a hit is immutable and cacheable forever; a miss is a 404
 * and not an error — the client simply stays on JSON.
 */
export function serveArtifact(pathname: string, registry: CodecRegistry): ArtifactResponse | undefined {
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
  limits?: Partial<Limits>;
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

/**
 * Parse artifact text, compile its content and verify its fingerprint (negotiation §3).
 * Malformed JSON throws `artifact`; invalid parsed content throws `ir`.
 */
export function loadArtifact<T = unknown>(text: string, fingerprint: string, options: LoadArtifactOptions = {}): Codec<T> {
  const expected = checkedFingerprint(fingerprint);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new HyperflyError("artifact", `artifact is not JSON: ${error.message}`, { cause: error });
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
    if (isInstance(error, HyperflyError)) throw error;
    throw new HyperflyError("ir", `artifact does not compile: ${messageOf(error, "unknown error")}`);
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

/**
 * Fetch and verify an offered artifact. 404 is a miss; other non-2xx statuses and
 * unreadable, oversized, non-UTF-8 or malformed JSON bodies throw `artifact`.
 * Invalid artifact/IR/profile content throws `ir`; identity mismatches throw
 * `fingerprint`. Network errors and aborts propagate.
 */
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
    throw new HyperflyError("artifact", `artifact fetch failed with status ${response.status}`);
  }
  const result = await readLimited(response.body, maxBytes);
  if (!result.ok) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (result.reason === "too-large") throw new HyperflyError("artifact", `artifact exceeds maxBytes ${maxBytes}`);
    throw new HyperflyError("artifact", "artifact body could not be read");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch {
    throw new HyperflyError("artifact", "artifact is not valid UTF-8");
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

/** A decoded response: the value and how it was sent, or the fingerprint of a codec the client does not hold. */
export type DecodedResponse<T> =
  | { kind: "json"; value: T }
  | { kind: "hyperfly"; value: T }
  | { kind: "unknown-codec"; fingerprint: string };

/**
 * Decode a response body according to what the server said it sent. A codec the
 * client does not hold is not an error the client can recover from by guessing,
 * so it is reported as a miss and the caller re-requests as JSON.
 * JSON uses strict UTF-8 and the first registered codec's value model, converting
 * canonical base64 to bytes and dropping unknown struct keys. An empty registry
 * leaves parsed JSON unchanged; conversion failures throw code `json`.
 */
export function decodeResponse<T>(
  contentType: string | null | undefined,
  body: Uint8Array | string,
  registry: CodecRegistry<T>,
): DecodedResponse<T> {
  if (mediaType(contentType) !== HYPERFLY_MEDIA_TYPE) {
    let text: string;
    try {
      text = typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch (cause) {
      throw new DecodeError("json", "$: body is not valid UTF-8", { cause });
    }
    try {
      return { kind: "json", value: parseJson(text, registry) };
    } catch (cause) {
      if (cause instanceof SyntaxError) throw new DecodeError("json", `$: ${cause.message}`, { cause });
      throw cause;
    }
  }
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const fingerprint = peekFingerprint(bytes);
  const codec = registry.get(fingerprint);
  if (!codec) return { kind: "unknown-codec", fingerprint };
  return { kind: "hyperfly", value: codec.decode(bytes) };
}

/** What `respond` reads: negotiation and encoding options plus the response's own status and headers. */
export interface RespondOptions extends NegotiateOptions, EncodeOptions {
  /** The response status. Default: 200. */
  status?: number;
  /** Extra response headers; Content-Type, Content-Length and the hyperfly headers are always the negotiated ones. Default: none. */
  headers?: Record<string, string>;
}

/**
 * Answer one request with `value`, in binary when the client can read it. Fetch-API
 * glue: one function covers Hono, Cloudflare Workers, Bun.serve, Deno and Next route
 * handlers, because they all speak Request and Response.
 */
export function respond<T>(
  request: Request,
  value: T,
  registry: CodecRegistry<T>,
  options: RespondOptions = {},
): Response {
  const decision = negotiate(request.headers.get(ACCEPT_HEADER), registry, {
    ...options,
    httpAccept: options.httpAccept === undefined ? request.headers.get("accept") : options.httpAccept,
  });
  const status = options.status ?? 200;
  const nullBody = NULL_BODY_STATUSES.has(status);
  const { body, headers } = nullBody ? { body: null, headers: decision.headers } : encodeFor(decision, value, options);
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
  return new Response(request.method === "HEAD" ? null : body as BodyInit | null, { status, headers: responseHeaders });
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

/** Why `readBody` refused a request body; the same strings as Python's `RequestError.reason`. */
export type RequestRefusal =
  | "unsupported-media-type"
  | "too-large"
  | "unreadable"
  | "malformed-json"
  | "malformed-envelope"
  | "codec-mismatch"
  | "unknown-codec"
  | "undecodable";

/** The decoded body, or the 400, 413 or 415 response to send back and why. */
export type ReadBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response; reason: RequestRefusal };

/** Read a hyperfly or JSON request body (negotiation §4). */
export async function readBody<T>(
  request: Request,
  registry: CodecRegistry<T>,
  options: ReadBodyOptions = {},
): Promise<ReadBodyResult<T>> {
  return readBodyWithinLimit(request, registry, bodyLimit(options.maxBytes));
}

/** Whether a Content-Length of ASCII digits names more than maxBytes, compared as digits so no length rounds. */
function exceeds(contentLength: string, maxBytes: number): boolean {
  if (!/^[0-9]+(?![\s\S])/.test(contentLength)) return false;
  let start = 0;
  while (start < contentLength.length - 1 && contentLength.charCodeAt(start) === 0x30) start++;
  const digits = contentLength.slice(start);
  const limit = String(maxBytes);
  return digits.length > limit.length || (digits.length === limit.length && digits > limit);
}

function bodyLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new HyperflyError("options", "maxBytes: must be a non-negative safe integer");
  }
  return maxBytes;
}

function refuse(status: 400 | 413 | 415, reason: RequestRefusal, headers?: Record<string, string>): ReadBodyResult<never> {
  return { ok: false, response: new Response(null, { status, headers }), reason };
}

async function readBodyWithinLimit<T>(
  request: Request,
  registry: CodecRegistry<T>,
  maxBytes: number,
): Promise<ReadBodyResult<T>> {
  const contentType = mediaType(request.headers.get("content-type"));
  const isHyperfly = contentType === HYPERFLY_MEDIA_TYPE;
  const isJson = contentType === "application/json"
    || /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+\+json(?![\s\S])/.test(contentType);
  if (!isHyperfly && !isJson) return refuse(415, "unsupported-media-type");
  if (exceeds(trimOws(request.headers.get("content-length") ?? ""), maxBytes)) return refuse(413, "too-large");
  const result = await readLimited(request.body, maxBytes);
  if (!result.ok) return refuse(result.reason === "too-large" ? 413 : 400, result.reason);
  const bytes = result.bytes;
  if (!isHyperfly) {
    try {
      return { ok: true, value: parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), registry) };
    } catch {
      return refuse(400, "malformed-json");
    }
  }
  let fingerprint: string;
  try {
    fingerprint = peekFingerprint(bytes);
  } catch (error) {
    if (isInstance(error, HyperflyError)) return refuse(400, "malformed-envelope");
    throw error;
  }
  const codecHeader = request.headers.get(CODEC_HEADER);
  if (codecHeader !== null && trimOws(codecHeader) !== fingerprint) return refuse(400, "codec-mismatch");
  const codec = registry.get(fingerprint);
  if (!codec) {
    const offer = registry.fingerprints[0];
    return refuse(415, "unknown-codec", offer ? { "Hyperfly-Offer": offer } : {});
  }
  try {
    return { ok: true, value: codec.decode(bytes) };
  } catch (error) {
    if (isInstance(error, HyperflyError)) return refuse(400, "undecodable");
    throw error;
  }
}

function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.cancel().catch(() => {});
  } catch {
    // Cancellation is best effort.
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too-large" | "unreadable" }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (stream !== null) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = stream.getReader();
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isUint8Array(value)) {
          cancelQuietly(reader);
          return { ok: false, reason: "unreadable" };
        }
        const size = byteLengthOf(value);
        length += size;
        if (length > maxBytes) {
          cancelQuietly(reader);
          return { ok: false, reason: "too-large" };
        }
        if (size > 0) chunks.push(new Uint8Array(value));
      }
    } catch {
      return { ok: false, reason: "unreadable" };
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
