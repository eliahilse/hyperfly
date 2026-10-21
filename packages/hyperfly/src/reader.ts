import { DecodeError } from "./errors.js";

/** Local encode and decode resource policy; each value must be a non-negative safe integer (wire-v0 §6). */
export interface Limits {
  /** Maximum enclosing struct, array and nullable nodes. Default: 64 (wire-v0 §6). */
  maxDepth: number;
  /** Maximum elements in one fixed or variable array. Default: 2^24 (wire-v0 §6). */
  maxItems: number;
  /** Maximum bytes per string/bytes value, packed blob or declared inflated total; schema literals and enum members are not capped. Default: 2^28 (wire-v0 §6). */
  maxByteLength: number;
  /**
   * Caps array counts at maxAmplification * (remaining bytes + 1) and the body item
   * budget at maxAmplification * (body length + 1). Row arrays with nonzero-bit
   * elements use the stricter remaining-bit bound for their counts. Default: 32 (wire-v0 §6).
   */
  maxAmplification: number;
  /** Maximum sum of every array count in one body, nested and sibling arrays alike. Default: 2^24 (wire-v0 §6). */
  maxTotalItems: number;
  /**
   * Maximum sum of decoded bytes of every string and bytes value in one body, including
   * literals, enum members and profile reconstructions. Default: 2^26 (wire-v0 §6).
   */
  maxTotalBytes: number;
  /** Caps one body's decoded bytes at maxByteAmplification * (body length + 1). Default: 64 (wire-v0 §6). */
  maxByteAmplification: number;
}

/** Frozen default resource policy for encoders and decoders (wire-v0 §6). */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxDepth: 64,
  maxItems: 2 ** 24,
  maxByteLength: 2 ** 28,
  maxAmplification: 32,
  maxTotalItems: 2 ** 24,
  maxTotalBytes: 2 ** 26,
  maxByteAmplification: 64,
});

/** Items charged so far against one body's cap; a sub-reader over the same body shares it. */
export interface ItemBudget {
  used: number;
  readonly cap: number;
}

/** Decoded string and bytes bytes charged so far against one body's cap, shared like ItemBudget. */
export interface ByteBudget {
  used: number;
  readonly cap: number;
}

export class Reader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  readonly limits: Limits;
  readonly budget: ItemBudget;
  readonly byteBudget: ByteBudget;

  constructor(buf: Uint8Array, limits: Limits, budget?: ItemBudget, byteBudget?: ByteBudget) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.limits = limits;
    this.budget = budget ?? {
      used: 0,
      cap: Math.min(limits.maxTotalItems, limits.maxAmplification * (buf.length + 1)),
    };
    this.byteBudget = byteBudget ?? {
      used: 0,
      cap: Math.min(limits.maxTotalBytes, limits.maxByteAmplification * (buf.length + 1)),
    };
  }

  /** Charges a string or bytes value's decoded length before its bytes are read or built. */
  chargeBytes(n: number, path: string, index?: number): void {
    const budget = this.byteBudget;
    if (n > budget.cap - budget.used) {
      const at = index === undefined ? path : `${path}[${index}]`;
      throw new DecodeError("limit", `${at}: ${budget.used + n} decoded bytes in this body exceed the byte budget of ${budget.cap}`);
    }
    budget.used += n;
  }

  u8(): number {
    if (this.offset >= this.buf.length) {
      throw new DecodeError("truncated", "unexpected end of input");
    }
    return this.buf[this.offset++]!;
  }

  bytes(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) {
      throw new DecodeError("truncated", "unexpected end of input");
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  f64le(): number {
    if (this.offset + 8 > this.buf.length) {
      throw new DecodeError("truncated", "unexpected end of input");
    }
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  u64le(): bigint {
    if (this.offset + 8 > this.buf.length) {
      throw new DecodeError("truncated", "unexpected end of input");
    }
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  isNegativeZeroAt(offsetBack: number): boolean {
    const hi = this.view.getUint32(this.offset - offsetBack + 4, true);
    const lo = this.view.getUint32(this.offset - offsetBack, true);
    return hi === 0x80000000 && lo === 0;
  }

  /** Fails as truncated, before anything is allocated, when fewer than n bytes remain. */
  need(n: number): void {
    if (n > this.buf.length - this.offset) {
      throw new DecodeError("truncated", "unexpected end of input");
    }
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  expectEnd(): void {
    if (this.offset !== this.buf.length) {
      throw new DecodeError("trailing", `${this.buf.length - this.offset} trailing byte(s) after body`);
    }
  }
}
