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
  | "ir"
  | "packed"
  | "unsupported";

export class HyperflyError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
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
