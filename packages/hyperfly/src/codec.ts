import { fingerprintOf, serializeArtifact, toHex, type PlanLayout } from "./canonical.js";
import { defaultPackHooks } from "./pack.js";
import { indexProfile, validateProfile, type Profile } from "./profile.js";
import { decodeNode } from "./decode.js";
import { checkByteBudget, checkItemBudget, encodeNode, type EncodeCtx } from "./encode.js";
import { DecodeError, FingerprintMismatchError, HyperflyError } from "./errors.js";
import { validateIR, withinStack, type IRNode } from "./ir.js";
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

/** Freezes a fresh clone in place, storing zero unsigned: an IR or profile -0 is the integer 0. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(record)) {
      if (Object.is(inner, -0)) record[key] = 0;
      else deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
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
    return { ir, profile: undefined, artifact: serializeArtifact(ir, plan) };
  }
  if (plan !== "columnar") {
    throw new HyperflyError("ir", "profiles apply to the columnar plan only");
  }
  validateProfile(ir, profile);
  // the profile is fixed by the fingerprint exactly as the IR is
  const frozen = deepFreeze(structuredClone(profile));
  return { ir, profile: frozen, artifact: serializeArtifact(ir, plan, frozen) };
}

export function compileIR<T = unknown>(input: IRNode, options: CompileOptions = {}): Codec<T> {
  const plan: PlanLayout = options.plan ?? "row";
  const { ir, profile: frozenProfile, artifact } = withinStack(() => compileArtifact(input, plan, options.profile));
  const profileIndex = indexProfile(frozenProfile);
  const fingerprintBytes = fingerprintOf(artifact);
  const fingerprint = toHex(fingerprintBytes);
  const limits: DecodeLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const columnar = plan === "columnar";
  const pack = options.pack === false ? {} : (options.pack ?? defaultPackHooks());

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
