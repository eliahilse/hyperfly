export { compileIR, HEADER_SIZE, MAGIC, WIRE_VERSION, type Codec, type CompileOptions, type PackHooks } from "./codec.js";
export { defaultPackHooks } from "./pack.js";
export { serializeArtifact, serializeNode, fingerprintOf, toHex, type PlanLayout } from "./canonical.js";
export { columnarEligible } from "./columnar.js";
export { validateIR, type IRField, type IRNode, type LiteralValue } from "./ir.js";
export { DEFAULT_LIMITS, type DecodeLimits } from "./reader.js";
export { INT_MAX, INT_MIN } from "./varint.js";
export {
  DecodeError,
  EncodeError,
  FingerprintMismatchError,
  HyperflyError,
  UnsupportedSchemaError,
  type ErrorCode,
} from "./errors.js";
export { sha256 } from "./sha256.js";
