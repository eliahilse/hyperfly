import { DecodeError } from "./errors.js";

export interface DecodeLimits {
  maxDepth: number;
  maxItems: number;
  maxByteLength: number;
  /**
   * Width-zero columns legitimately encode any number of rows in a handful of
   * bytes, so input length cannot bound a columnar row count. This caps the
   * work a byte of hostile input can demand instead: a count above
   * maxAmplification * (remaining bytes + 1) is rejected. Local decode
   * policy, like every other limit — raise it for routes that really ship
   * millions of constant rows.
   */
  maxAmplification: number;
}

export const DEFAULT_LIMITS: DecodeLimits = {
  maxDepth: 64,
  maxItems: 2 ** 24,
  maxByteLength: 2 ** 28,
  maxAmplification: 4096,
};

export class Reader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  readonly limits: DecodeLimits;

  constructor(buf: Uint8Array, limits: DecodeLimits) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.limits = limits;
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

  remaining(): number {
    return this.buf.length - this.offset;
  }

  expectEnd(): void {
    if (this.offset !== this.buf.length) {
      throw new DecodeError("trailing", `${this.buf.length - this.offset} trailing byte(s) after body`);
    }
  }
}
