import { fingerprintOf, serializeArtifact, toHex, type PlanLayout } from "./canonical.js";
import { defaultPackHooks } from "./pack.js";
import { indexProfile, validateProfile, type Profile } from "./profile.js";
import { decodeNode } from "./decode.js";
import { encodeNode } from "./encode.js";
import { DecodeError, FingerprintMismatchError, HyperflyError } from "./errors.js";
import { validateIR, type IRNode } from "./ir.js";
import { DEFAULT_LIMITS, Reader, type DecodeLimits } from "./reader.js";
import { Writer } from "./writer.js";

export const MAGIC = new Uint8Array([0x68, 0x66]);
export const WIRE_VERSION = 1;
export const HEADER_SIZE = 19;

export interface PackHooks {
  deflate?: (data: Uint8Array) => Uint8Array;
  inflate?: (data: Uint8Array, maxOutputLength: number) => Uint8Array;
}

export interface CompileOptions {
  limits?: Partial<DecodeLimits>;
  plan?: PlanLayout;
  pack?: PackHooks | false;
  profile?: Profile;
}

export interface Codec<T = unknown> {
  readonly ir: IRNode;
  readonly artifact: string;
  readonly fingerprint: string;
  readonly plan: PlanLayout;
  readonly profile?: Profile;
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
  encodeBody(value: T): Uint8Array;
  decodeBody(bytes: Uint8Array): T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export function compileIR<T = unknown>(ir: IRNode, options: CompileOptions = {}): Codec<T> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new HyperflyError("options", "options: must be an object");
  }
  const limits: DecodeLimits = { ...DEFAULT_LIMITS };
  if (options.limits !== undefined) {
    if (typeof options.limits !== "object" || options.limits === null || Array.isArray(options.limits)) {
      throw new HyperflyError("options", "limits: must be an object");
    }
    const allowed = new Set(Object.keys(DEFAULT_LIMITS));
    for (const key of Reflect.ownKeys(options.limits)) {
      if (!Object.prototype.propertyIsEnumerable.call(options.limits, key)) continue;
      if (typeof key !== "string" || !allowed.has(key)) {
        throw new HyperflyError("options", `limits.${String(key)}: unknown limit`);
      }
      const value = options.limits[key as keyof DecodeLimits];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new HyperflyError("options", `limits.${key}: must be a non-negative safe integer`);
      }
      limits[key as keyof DecodeLimits] = value;
    }
  }
  if (options.plan !== undefined && options.plan !== "row" && options.plan !== "columnar") {
    throw new HyperflyError("options", "plan: must be row or columnar");
  }
  if (options.pack !== undefined && options.pack !== false) {
    if (typeof options.pack !== "object" || options.pack === null) {
      throw new HyperflyError("options", "pack: must be false or an object");
    }
    for (const key of ["deflate", "inflate"] as const) {
      if (options.pack[key] !== undefined && typeof options.pack[key] !== "function") {
        throw new HyperflyError("options", `pack.${key}: must be a function`);
      }
    }
  }
  validateIR(ir);
  // isolate from later mutation, caller-side or through codec.ir: the fingerprint is
  // fixed at compile time and the schema behind it must not drift
  ir = deepFreeze(structuredClone(ir));
  const plan: PlanLayout = options.plan ?? "row";
  const profile = options.profile;
  if (profile !== undefined) {
    if (plan !== "columnar") {
      throw new HyperflyError("ir", "profiles apply to the columnar plan only");
    }
    validateProfile(ir, profile);
  }
  // the profile is fixed by the fingerprint exactly as the IR is
  const frozenProfile = profile ? deepFreeze(structuredClone(profile)) : undefined;
  const profileIndex = indexProfile(frozenProfile);
  const artifact = serializeArtifact(ir, plan, frozenProfile);
  const fingerprintBytes = fingerprintOf(artifact);
  const fingerprint = toHex(fingerprintBytes);
  const columnar = plan === "columnar";
  const pack = options.pack === false ? {} : (options.pack ?? defaultPackHooks());

  const encodeBody = (value: T): Uint8Array => {
    const w = new Writer();
    encodeNode(w, ir, value, "$", 0, {
      maxDepth: limits.maxDepth,
      maxItems: limits.maxItems,
      maxByteLength: limits.maxByteLength,
      maxAmplification: limits.maxAmplification,
      columnar,
      deflate: pack.deflate,
      canInflate: pack.inflate !== undefined,
      profile: profileIndex,
    });
    return w.finish();
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
