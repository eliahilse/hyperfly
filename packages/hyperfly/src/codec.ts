import { fingerprintOf, serializeArtifact, toHex, type PlanLayout } from "./canonical.js";
import { defaultPackHooks } from "./pack.js";
import { checkedProfile, indexProfile, type Profile } from "./profile.js";
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
  limits: DecodeLimits;
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
    const checkedLimits: DecodeLimits = { ...DEFAULT_LIMITS };
    if (limits !== undefined) {
      if (!isPlainObject(limits)) {
        throw new HyperflyError("options", "limits: must be an object");
      }
      const allowed = new Set(Object.keys(DEFAULT_LIMITS));
      const snapshot: Partial<DecodeLimits> = {};
      for (const key of Reflect.ownKeys(limits)) {
        if (typeof key !== "string" || !allowed.has(key)) {
          throw new HyperflyError("options", `limits.${String(key)}: unknown limit`);
        }
        snapshot[key as keyof DecodeLimits] = readOption(() => limits[key as keyof DecodeLimits]);
      }
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new HyperflyError("options", `limits.${key}: must be a non-negative safe integer`);
        }
        checkedLimits[key as keyof DecodeLimits] = value;
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
    if (cause instanceof HyperflyError && cause.code === "options") throw cause;
    throw new HyperflyError("options", "options: could not read compile options", { cause });
  }
}

export function compileIR<T = unknown>(ir: IRNode, options: CompileOptions = {}): Codec<T> {
  const { limits, plan, pack: packOptions, profile } = checkedOptions(options);
  validateIR(ir);
  // isolate from later mutation, caller-side or through codec.ir: the fingerprint is
  // fixed at compile time and the schema behind it must not drift
  ir = deepFreeze(structuredClone(ir));
  let frozenProfile: Profile | undefined;
  if (profile !== undefined) {
    if (plan !== "columnar") {
      throw new HyperflyError("ir", "profiles apply to the columnar plan only");
    }
    frozenProfile = deepFreeze(checkedProfile(ir, profile));
  }
  const profileIndex = indexProfile(frozenProfile);
  const artifact = serializeArtifact(ir, plan, frozenProfile);
  const fingerprintBytes = fingerprintOf(artifact);
  const fingerprint = toHex(fingerprintBytes);
  const columnar = plan === "columnar";
  const pack = packOptions === false ? {} : (packOptions ?? defaultPackHooks());

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
