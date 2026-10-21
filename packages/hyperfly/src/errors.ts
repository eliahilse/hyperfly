/**
 * Stable failure categories; messages are descriptive, not contractual (wire-v0 §9).
 * `varint`: non-minimal ULEB128 or more than eight bytes on decode.
 * `range`: declared bounds or a numeric value, index, code or derived source is out of range.
 * `type`: an encoded value mismatches its type, literal, enum, fixed length or nullability.
 * `required`: an encoded struct omits a required field.
 * `utf8`: a string contains a lone surrogate on encode or invalid UTF-8 on decode.
 * `float`: a float is non-finite, or decode encounters negative zero or non-minimal XOR encoding.
 * `marker`: a boolean, nullable marker, column mode or mode parameter is invalid.
 * `bitmap`: bitmap or packed padding, null bits, escape bits or patched-frame exceptions are invalid.
 * `trailing`: bytes remain after a complete body.
 * `truncated`: input ends before a value is complete.
 * `depth`: traversal exceeds maxDepth.
 * `limit`: an item, byte, amplification or remaining-input bound is exceeded.
 * `header`: an envelope is short or has invalid magic or wire major.
 * `fingerprint`: an envelope or artifact fingerprint mismatches, or an artifact fingerprint is malformed.
 * `ir`: IR or a profile is invalid, or an artifact names an unimplemented wire, layout or plan version.
 * `packed`: DEFLATE is invalid, has trailing bytes or produces the wrong inflated length, or a deflate hook fails or returns a non-Uint8Array.
 * `unsupported`: inflate capability, a required profile entry or a schema construct is unsupported.
 * `artifact`: a discovery response or artifact text cannot be read: a non-2xx status other than a 404 miss, or a body that is unreadable, oversized, non-UTF-8 or not well-formed JSON; parsed content that is not a valid artifact is `ir`.
 * `json`: in an adapter, JSON parsing or UTF-8 decoding fails, or a JSON value does not convert under the codec (for example invalid base64 at a bytes position).
 * `validation`: schema parsing fails when Zod validation is enabled.
 * `options`: compile, training or adapter options are invalid or cannot be read.
 */
export type ErrorCode =
  | "varint"
  | "range"
  | "type"
  | "required"
  | "utf8"
  | "float"
  | "marker"
  | "bitmap"
  | "trailing"
  | "truncated"
  | "depth"
  | "limit"
  | "header"
  | "fingerprint"
  | "artifact"
  | "ir"
  | "packed"
  | "unsupported"
  | "json"
  | "validation"
  | "options";

/** Base error carrying a stable failure code (wire-v0 §9). */
export class HyperflyError extends Error {
  /** Machine-readable failure category; message text may vary (wire-v0 §9). */
  readonly code: ErrorCode;

  /** Sets the failure category and message, preserving an optional cause. */
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** `instanceof` for caught values: one whose prototype cannot be read, such as a revoked proxy, is not an instance. */
export function isInstance<T>(value: unknown, type: abstract new (...args: never[]) => T): value is T {
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

/** The message of a caught value, or `fallback` when it is not an Error or string or cannot be read. */
export function messageOf(value: unknown, fallback: string): string {
  try {
    if (value instanceof Error) return String(value.message);
  } catch {
    return fallback;
  }
  return typeof value === "string" ? value : fallback;
}

/** Failure to encode a value under the schema, plan or limits (wire-v0 §9). */
export class EncodeError extends HyperflyError {}

/** Failure to decode a body or envelope under the schema, plan or limits (wire-v0 §9). */
export class DecodeError extends HyperflyError {}

/** Decode failure with code `fingerprint` when codec and payload fingerprints differ (wire-v0 §2). */
export class FingerprintMismatchError extends DecodeError {
  /** Fingerprint required by the codec or artifact request. */
  readonly expected: string;
  /** Fingerprint found in the envelope or computed from the loaded artifact. */
  readonly actual: string;

  /** Records both fingerprints and sets code `fingerprint`. */
  constructor(expected: string, actual: string) {
    super("fingerprint", `codec fingerprint ${expected} does not match payload ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** Schema-adapter failure with code `unsupported` for a construct without an IR encoding (wire-v0 §9). */
export class UnsupportedSchemaError extends HyperflyError {
  /** Schema location of the unsupported construct, rooted at `$`. */
  readonly path: string;

  /** Includes the schema path in the failure message. */
  constructor(path: string, message: string) {
    super("unsupported", `${path}: ${message}`);
    this.path = path;
  }
}
