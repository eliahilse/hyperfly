import { DecodeError, EncodeError } from "./errors.js";
import type { Reader } from "./reader.js";
import type { Writer } from "./writer.js";

export const INT_MIN = -(2 ** 53 - 1);
export const INT_MAX = 2 ** 53 - 1;

const MAX_ULEB_BYTES = 8;
const ULEB_DOMAIN_MAX = (1n << 56n) - 1n;

export function writeUleb(w: Writer, value: bigint): void {
  if (value < 0n || value > ULEB_DOMAIN_MAX) {
    throw new EncodeError("range", `uvarint out of v0 domain: ${value}`);
  }
  let v = value;
  for (;;) {
    const group = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      w.u8(group);
      return;
    }
    w.u8(group | 0x80);
  }
}

export function readUleb(r: Reader): bigint {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_ULEB_BYTES; i++) {
    const byte = r.u8();
    const group = byte & 0x7f;
    result |= BigInt(group) << shift;
    if ((byte & 0x80) === 0) {
      if (i > 0 && group === 0) {
        throw new DecodeError("varint", "overlong uvarint encoding");
      }
      return result;
    }
    shift += 7n;
  }
  throw new DecodeError("varint", `uvarint longer than ${MAX_ULEB_BYTES} bytes`);
}

export function zigzag(v: bigint): bigint {
  return v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
}

export function unzigzag(u: bigint): bigint {
  return (u & 1n) === 1n ? -((u + 1n) >> 1n) : u >> 1n;
}

export function ulebLen(value: bigint): number {
  let v = value;
  let len = 1;
  while (v > 0x7fn) {
    v >>= 7n;
    len++;
  }
  return len;
}
