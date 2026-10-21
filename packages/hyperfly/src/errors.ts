/** Stable failure codes. `artifact` means an unreadable discovery response or artifact JSON text; invalid parsed content is `ir`. */
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

export class HyperflyError extends Error {
  readonly code: ErrorCode;

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

export class EncodeError extends HyperflyError {}

export class DecodeError extends HyperflyError {}

export class FingerprintMismatchError extends DecodeError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super("fingerprint", `codec fingerprint ${expected} does not match payload ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnsupportedSchemaError extends HyperflyError {
  readonly path: string;

  constructor(path: string, message: string) {
    super("unsupported", `${path}: ${message}`);
    this.path = path;
  }
}
