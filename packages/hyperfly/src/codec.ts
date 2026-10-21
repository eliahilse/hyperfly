import { canonicalArtifact, fingerprintOf, toHex, type PlanLayout } from "./canonical.js";
import { defaultPackHooks } from "./pack.js";
import { checkedProfile, indexProfile, type Profile } from "./profile.js";
import { decodeNode } from "./decode.js";
import { checkByteBudget, checkItemBudget, encodeNode, type EncodeCtx } from "./encode.js";
import { DecodeError, FingerprintMismatchError, HyperflyError, isInstance } from "./errors.js";
import { validateIR, withinStack, type IRNode } from "./ir.js";
import { DEFAULT_LIMITS, Reader, type Limits } from "./reader.js";
import { Writer } from "./writer.js";

/** Envelope magic bytes `0x68 0x66` (wire-v0 §2). */
export const MAGIC = new Uint8Array([0x68, 0x66]);
/** Wire major stored in the envelope and canonical artifact: 1 (wire-v0 §2, wire-v0 §5). */
export const WIRE_VERSION = 1;
/** Envelope header length in bytes, including the 16-byte fingerprint (wire-v0 §2). */
export const HEADER_SIZE = 19;

/** Synchronous raw DEFLATE capabilities for packed string columns (plan-columnar-v5 §3). */
export interface PackHooks {
  /** Compresses one raw DEFLATE stream; omission disables packed-column encoding. */
  deflate?: (data: Uint8Array) => Uint8Array;
  /** Inflates exactly one stream, rejecting trailing bytes and output above maxOutputLength; omission refuses packed columns. */
  inflate?: (data: Uint8Array, maxOutputLength: number) => Uint8Array;
}

/** Local codec policy and artifact layout selected at compile time. */
export interface CompileOptions {
  /** Resource caps; omitted entries use DEFAULT_LIMITS. Values must be non-negative safe integers (wire-v0 §6). */
  limits?: Partial<Limits>;
  /** Body layout included in the fingerprint. Default: `row`. */
  plan?: PlanLayout;
  /** Raw DEFLATE capabilities. Default: defaultPackHooks(); false disables both compression and inflation. */
  pack?: PackHooks | false;
  /** Shared string-column model, valid only with the columnar plan. Default: none. */
  profile?: Profile;
}

/** Frozen codec whose schema, layout and shared profile determine its fingerprint (wire-v0 §5). */
export interface Codec<T = unknown> {
  /** Validated, cloned and deeply frozen schema. */
  readonly ir: IRNode;
  /** Canonical artifact text identifying the wire major, plan, schema and shared profile (wire-v0 §5). */
  readonly artifact: string;
  /** First 16 SHA-256 bytes of the artifact as 32 lowercase hex characters (wire-v0 §5). */
  readonly fingerprint: string;
  /** Body layout fixed in the artifact. */
  readonly plan: PlanLayout;
  /** Validated, cloned and deeply frozen training profile, when supplied. */
  readonly profile?: Profile;
  /**
   * Encode a value into an envelope. A struct value must be an object whose `Object.prototype.toString` tag is
   * `"[object Object]"` (plain objects, null-prototype objects and class instances); typed arrays, Map, Set, Date and
   * boxed primitives fail with `type`.
   */
  encode(value: T): Uint8Array;
  /** Checks the envelope header and fingerprint, then decodes the complete body (wire-v0 §2). */
  decode(bytes: Uint8Array): T;
  /** Encodes a body without the envelope header, enforcing the same value checks and limits. */
  encodeBody(value: T): Uint8Array;
  /** Decodes a complete body without a header or fingerprint check; rejects trailing bytes. */
  decodeBody(bytes: Uint8Array): T;
}

/** Freezes a fresh clone in place, storing zero unsigned: an IR or profile -0 is the integer 0. */
function deepFreeze<T>(value: T): T {
  let current: unknown = value;
  let stack: object[] | undefined;
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const inner = record[key];
      if (Object.is(inner, -0)) record[key] = 0;
      else if (inner && typeof inner === "object") (stack ??= []).push(inner);
    }
    Object.freeze(current);
    current = stack?.pop();
  }
  return value;
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOption<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new HyperflyError("options", "options: could not read compile options", { cause });
  }
}

interface CheckedOptions {
  limits: Limits;
  plan: PlanLayout;
  pack: PackHooks | false | undefined;
  profile: Profile | undefined;
  validate: boolean | undefined;
}

export function checkedOptions(options: CompileOptions & { validate?: boolean }): CheckedOptions {
  try {
    if (!isPlainObject(options)) {
      throw new HyperflyError("options", "options: must be an object");
    }
    const limits = readOption(() => options.limits);
    const plan = readOption(() => options.plan);
    const pack = readOption(() => options.pack);
    const profile = readOption(() => options.profile);
    const validate = readOption(() => options.validate);
    const checkedLimits: Limits = { ...DEFAULT_LIMITS };
    if (limits !== undefined) {
      if (!isPlainObject(limits)) {
        throw new HyperflyError("options", "limits: must be an object");
      }
      const allowed = new Set(Object.keys(DEFAULT_LIMITS));
      const snapshot: Partial<Limits> = {};
      for (const key of Reflect.ownKeys(limits)) {
        if (typeof key !== "string" || !allowed.has(key)) {
          throw new HyperflyError("options", `limits.${String(key)}: unknown limit`);
        }
        snapshot[key as keyof Limits] = readOption(() => limits[key as keyof Limits]);
      }
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new HyperflyError("options", `limits.${key}: must be a non-negative safe integer`);
        }
        checkedLimits[key as keyof Limits] = value;
      }
    }
    if (plan !== undefined && plan !== "row" && plan !== "columnar") {
      throw new HyperflyError("options", "plan: must be row or columnar");
    }
    let checkedPack = pack;
    if (pack !== undefined && pack !== false) {
      if (!isPlainObject(pack)) {
        throw new HyperflyError("options", "pack: must be false or an object");
      }
      const deflate = readOption(() => pack.deflate);
      const inflate = readOption(() => pack.inflate);
      for (const [key, value] of Object.entries({ deflate, inflate })) {
        if (value !== undefined && typeof value !== "function") {
          throw new HyperflyError("options", `pack.${key}: must be a function`);
        }
      }
      checkedPack = { deflate, inflate };
    }
    if (validate !== undefined && typeof validate !== "boolean") {
      throw new HyperflyError("options", "validate: must be a boolean");
    }
    return { limits: checkedLimits, plan: plan ?? "row", pack: checkedPack, profile, validate };
  } catch (cause) {
    if (isInstance(cause, HyperflyError) && cause.code === "options") throw cause;
    throw new HyperflyError("options", "options: could not read compile options", { cause });
  }
}

function compileArtifact(
  ir: IRNode,
  plan: PlanLayout,
  profile: Profile | undefined,
): { ir: IRNode; profile: Profile | undefined; artifact: string } {
  validateIR(ir);
  // isolate from later mutation, caller-side or through codec.ir: the fingerprint is
  // fixed at compile time and the schema behind it must not drift
  ir = deepFreeze(structuredClone(ir));
  if (profile === undefined || profile === null) {
    return { ir, profile: undefined, artifact: canonicalArtifact(ir, plan) };
  }
  if (plan !== "columnar") {
    throw new HyperflyError("ir", "profiles apply to the columnar plan only");
  }
  // the profile is fixed by the fingerprint exactly as the IR is
  const frozen = deepFreeze(checkedProfile(ir, profile));
  return { ir, profile: frozen, artifact: canonicalArtifact(ir, plan, frozen) };
}

/**
 * Validates and snapshots an IR and optional profile into a frozen codec (wire-v0 §4, wire-v0 §5).
 * Invalid options fail with `options`; invalid IR or profiles fail with `ir`.
 */
export function compileIR<T = unknown>(input: IRNode, options: CompileOptions = {}): Codec<T> {
  const { limits, plan, pack: packOptions, profile } = checkedOptions(options);
  const { ir, profile: frozenProfile, artifact } = withinStack(() => compileArtifact(input, plan, profile));
  const profileIndex = indexProfile(frozenProfile);
  const fingerprintBytes = fingerprintOf(artifact);
  const fingerprint = toHex(fingerprintBytes);
  const columnar = plan === "columnar";
  const pack = packOptions === false ? {} : (packOptions ?? defaultPackHooks());

  const encodeBody = (value: T): Uint8Array => {
    const w = new Writer();
    const ctx: EncodeCtx = {
      maxDepth: limits.maxDepth,
      maxItems: limits.maxItems,
      maxByteLength: limits.maxByteLength,
      maxAmplification: limits.maxAmplification,
      maxTotalItems: limits.maxTotalItems,
      maxTotalBytes: limits.maxTotalBytes,
      maxByteAmplification: limits.maxByteAmplification,
      items: 0,
      bytes: 0,
      columnar,
      deflate: pack.deflate,
      canInflate: pack.inflate !== undefined,
      profile: profileIndex,
    };
    encodeNode(w, ir, value, "$", 0, ctx);
    const body = w.finish();
    checkItemBudget(ctx, body.length);
    checkByteBudget(ctx, body.length);
    return body;
  };

  const decodeBody = (bytes: Uint8Array): T => {
    const r = new Reader(bytes, limits);
    const value = decodeNode(r, ir, "$", 0, columnar, pack.inflate, profileIndex);
    r.expectEnd();
    return value as T;
  };

  return Object.freeze({
    ir,
    artifact,
    fingerprint,
    plan,
    profile: frozenProfile,
    encodeBody,
    decodeBody,
    encode(value: T): Uint8Array {
      const body = encodeBody(value);
      const out = new Uint8Array(HEADER_SIZE + body.length);
      out[0] = 0x68;
      out[1] = 0x66;
      out[2] = WIRE_VERSION;
      out.set(fingerprintBytes, 3);
      out.set(body, HEADER_SIZE);
      return out;
    },
    decode(bytes: Uint8Array): T {
      if (bytes.length < HEADER_SIZE) throw new DecodeError("header", "shorter than envelope header");
      if (bytes[0] !== 0x68 || bytes[1] !== 0x66) throw new DecodeError("header", "bad magic");
      if (bytes[2] !== WIRE_VERSION) throw new DecodeError("header", `unsupported wire major ${bytes[2]}`);
      const actual = toHex(bytes.subarray(3, HEADER_SIZE));
      if (actual !== fingerprint) throw new FingerprintMismatchError(fingerprint, actual);
      return decodeBody(bytes.subarray(HEADER_SIZE));
    },
  });
}
