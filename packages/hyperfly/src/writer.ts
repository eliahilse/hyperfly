import { byteLengthOf, copyBytes } from "./typed-array.js";

export class Writer {
  private buf: Uint8Array;
  private len = 0;
  private view: DataView;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  get size(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    copyBytes(grown, this.buf.subarray(0, this.len), 0);
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(byte: number): void {
    this.ensure(1);
    this.buf[this.len++] = byte;
  }

  bytes(data: Uint8Array, length = byteLengthOf(data)): void {
    this.ensure(length);
    copyBytes(this.buf, data, this.len);
    this.len += length;
  }

  f64le(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
  }

  u64le(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.len, value, true);
    this.len += 8;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
