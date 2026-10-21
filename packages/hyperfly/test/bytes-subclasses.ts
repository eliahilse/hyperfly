import { runInNewContext } from "node:vm";

/** Hostile accessors and methods must never be consulted when measuring or copying bytes. */
export const bytesSubclasses: [string, (bytes: Uint8Array) => Uint8Array][] = [
  ...["length", "byteLength", "byteOffset", "buffer", "subarray", "set"].map((key): [string, (bytes: Uint8Array) => Uint8Array] => [
    key,
    (bytes) => {
      class Hostile extends Uint8Array {}
      Object.defineProperty(Hostile.prototype, key, {
        get() { throw new Error(`must not read ${key}`); },
      });
      // Include surrounding bytes so reading the wrong offset or buffer corrupts the result.
      const backing = new Uint8Array(bytes.length + 2);
      backing.set(bytes, 1);
      return new Hostile(backing.buffer, 1, bytes.length);
    },
  ]),
  ["cross-realm subclass", runInNewContext(`(bytes) => new (class extends Uint8Array {
    get length() { throw new Error("length"); }
    get byteLength() { throw new Error("byteLength"); }
    get byteOffset() { throw new Error("byteOffset"); }
    get buffer() { throw new Error("buffer"); }
    subarray() { throw new Error("subarray"); }
    set() { throw new Error("set"); }
  })(bytes)`) as (bytes: Uint8Array) => Uint8Array],
];
