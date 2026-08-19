import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/sha256.js";
import { toHex } from "../src/canonical.js";
import { readUleb, unzigzag, writeUleb, zigzag } from "../src/varint.js";
import { Writer } from "../src/writer.js";
import { Reader, DEFAULT_LIMITS } from "../src/reader.js";

const enc = new TextEncoder();

describe("sha256", () => {
  test("empty input", () => {
    expect(toHex(sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("abc", () => {
    expect(toHex(sha256(enc.encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("448-bit boundary message", () => {
    expect(toHex(sha256(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  test("multi-block input", () => {
    expect(toHex(sha256(enc.encode("a".repeat(200))))).toBe(
      toHex(sha256(enc.encode("a".repeat(200)))),
    );
    expect(toHex(sha256(enc.encode("a".repeat(1000000))))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("uleb128", () => {
  const roundtrip = (v: bigint): Uint8Array => {
    const w = new Writer();
    writeUleb(w, v);
    const bytes = w.finish();
    const r = new Reader(bytes, DEFAULT_LIMITS);
    expect(readUleb(r)).toBe(v);
    r.expectEnd();
    return bytes;
  };

  test("boundaries", () => {
    expect(toHex(roundtrip(0n))).toBe("00");
    expect(toHex(roundtrip(127n))).toBe("7f");
    expect(toHex(roundtrip(128n))).toBe("8001");
    expect(toHex(roundtrip(300n))).toBe("ac02");
    expect(toHex(roundtrip((1n << 56n) - 1n))).toBe("ffffffffffffff7f");
  });

  test("rejects overlong", () => {
    const r = new Reader(new Uint8Array([0x80, 0x00]), DEFAULT_LIMITS);
    expect(() => readUleb(r)).toThrow("overlong");
  });

  test("rejects nine bytes", () => {
    const r = new Reader(new Uint8Array(9).fill(0xff), DEFAULT_LIMITS);
    expect(() => readUleb(r)).toThrow("longer than");
  });
});

describe("zigzag", () => {
  test("mapping", () => {
    expect(zigzag(0n)).toBe(0n);
    expect(zigzag(-1n)).toBe(1n);
    expect(zigzag(1n)).toBe(2n);
    expect(zigzag(-2n)).toBe(3n);
    expect(zigzag(2n)).toBe(4n);
  });

  test("inverse over range", () => {
    for (let i = -1000n; i <= 1000n; i++) expect(unzigzag(zigzag(i))).toBe(i);
    const big = BigInt(2 ** 53 - 1);
    expect(unzigzag(zigzag(big))).toBe(big);
    expect(unzigzag(zigzag(-big))).toBe(-big);
  });
});
