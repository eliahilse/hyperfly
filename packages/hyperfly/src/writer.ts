export class Writer {
  private buf: Uint8Array;
  private len = 0;
  private view: DataView;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(byte: number): void {
    this.ensure(1);
    this.buf[this.len++] = byte;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  f64le(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
