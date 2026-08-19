import { fingerprintOf, serializeArtifact, toHex } from "./canonical.js";
import { decodeNode } from "./decode.js";
import { encodeNode } from "./encode.js";
import { DecodeError, FingerprintMismatchError } from "./errors.js";
import { validateIR, type IRNode } from "./ir.js";
import { DEFAULT_LIMITS, Reader, type DecodeLimits } from "./reader.js";
import { Writer } from "./writer.js";

export const MAGIC = new Uint8Array([0x68, 0x66]);
export const WIRE_VERSION = 1;
export const HEADER_SIZE = 19;

export interface CompileOptions {
  limits?: Partial<DecodeLimits>;
}

export interface Codec<T = unknown> {
  readonly ir: IRNode;
  readonly artifact: string;
  readonly fingerprint: string;
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
  encodeBody(value: T): Uint8Array;
  decodeBody(bytes: Uint8Array): T;
}

export function compileIR<T = unknown>(ir: IRNode, options: CompileOptions = {}): Codec<T> {
  validateIR(ir);
  const artifact = serializeArtifact(ir);
  const fingerprintBytes = fingerprintOf(artifact);
  const fingerprint = toHex(fingerprintBytes);
  const limits: DecodeLimits = { ...DEFAULT_LIMITS, ...options.limits };

  const encodeBody = (value: T): Uint8Array => {
    const w = new Writer();
    encodeNode(w, ir, value, "$", 0, limits.maxDepth);
    return w.finish();
  };

  const decodeBody = (bytes: Uint8Array): T => {
    const r = new Reader(bytes, limits);
    const value = decodeNode(r, ir, "$", 0);
    r.expectEnd();
    return value as T;
  };

  return {
    ir,
    artifact,
    fingerprint,
    encodeBody,
    decodeBody,
    encode(value: T): Uint8Array {
      const body = encodeBody(value);
      const out = new Uint8Array(HEADER_SIZE + body.length);
      out.set(MAGIC, 0);
      out[2] = WIRE_VERSION;
      out.set(fingerprintBytes, 3);
      out.set(body, HEADER_SIZE);
      return out;
    },
    decode(bytes: Uint8Array): T {
      if (bytes.length < HEADER_SIZE) throw new DecodeError("header", "shorter than envelope header");
      if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) throw new DecodeError("header", "bad magic");
      if (bytes[2] !== WIRE_VERSION) throw new DecodeError("header", `unsupported wire major ${bytes[2]}`);
      const actual = toHex(bytes.subarray(3, HEADER_SIZE));
      if (actual !== fingerprint) throw new FingerprintMismatchError(fingerprint, actual);
      return decodeBody(bytes.subarray(HEADER_SIZE));
    },
  };
}
