import { DecodeError } from "./errors.js";

export interface DecodeLimits {
  maxDepth: number;
  maxItems: number;
  maxByteLength: number;
  /**
   * Width-zero columns and arrays of literals legitimately encode any number of
   * rows in a handful of bytes, so input length cannot bound such a count. This
   * caps the work a byte of hostile input can demand instead: a count above
   * maxAmplification * (remaining bytes + 1) is rejected, and the item budget
   * of one body is capped at maxAmplification * (body length + 1). Local decode
   * policy, like every other limit — raise it for routes that really ship
   * millions of constant rows.
   */
  maxAmplification: number;
  /** Sum of every array count in one body, nested and sibling arrays alike (wire-v0 §6). */
  maxTotalItems: number;
  /**
   * Sum of the decoded bytes of every string and bytes value in one body, including
   * literals, enum members and profile reconstructions (wire-v0 §6).
   */
  maxTotalBytes: number;
  /** The byte budget of one body is capped at maxByteAmplification * (body length + 1). */
  maxByteAmplification: number;
}

export const DEFAULT_LIMITS: Readonly<DecodeLimits> = Object.freeze({
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
  readonly limits: DecodeLimits;
  readonly budget: ItemBudget;
  readonly byteBudget: ByteBudget;

  constructor(buf: Uint8Array, limits: DecodeLimits, budget?: ItemBudget, byteBudget?: ByteBudget) {
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
