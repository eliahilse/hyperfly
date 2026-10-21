import type { PackHooks } from "./codec.js";
import { DecodeError } from "./errors.js";
import { inflateRaw } from "./inflate.js";

interface ZlibLike {
  deflateRawSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
  inflateRawSync(
    data: Uint8Array,
    options: { maxOutputLength: number; info: true },
  ): { buffer: Uint8Array; engine?: { bytesWritten?: number } } | Uint8Array;
}

/**
 * node:zlib resolved at runtime so the module stays importable in browsers and
 * edge runtimes. Those inflate with the pure-JS inflater and, unable to deflate,
 * emit plain string columns (DecompressionStream is async and cannot back the
 * sync codec API).
 */
function builtinZlib(): ZlibLike | null {
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule;
  if (typeof get !== "function") return null;
  try {
    return (get("node:zlib") as ZlibLike) ?? null;
  } catch {
    return null;
  }
}

function zlibInflate(zlib: ZlibLike, data: Uint8Array, maxOutputLength: number): Uint8Array {
  let result: ReturnType<ZlibLike["inflateRawSync"]>;
  try {
    // node rejects a zero limit; one past the cap still stops an over-long stream early
    result = zlib.inflateRawSync(data, { maxOutputLength: maxOutputLength + 1, info: true });
  } catch (err) {
    throw new DecodeError("packed", "deflate: invalid stream", { cause: err });
  }
  const consumed = result instanceof Uint8Array ? undefined : result.engine?.bytesWritten;
  // a zlib without `info` cannot report what it consumed, so the strict inflater decides
  if (typeof consumed !== "number") return inflateRaw(data, maxOutputLength);
  const out = (result as { buffer: Uint8Array }).buffer;
  // zlib stops at the final block and ignores the rest; the spec requires exactly one stream
  if (consumed !== data.length) throw new DecodeError("packed", "deflate: trailing bytes after the final block");
  if (out.length > maxOutputLength) throw new DecodeError("packed", `deflate: output exceeds ${maxOutputLength} bytes`);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/**
 * Supplies raw DEFLATE hooks using node:zlib when available, with compression level 6.
 * Otherwise supplies only the strict JavaScript inflater (plan-columnar-v5 §3).
 */
export function defaultPackHooks(): PackHooks {
  const zlib = builtinZlib();
  if (!zlib) return { inflate: inflateRaw };
  return {
    deflate: (data) => new Uint8Array(zlib.deflateRawSync(data, { level: 6 })),
    inflate: (data, maxOutputLength) => zlibInflate(zlib, data, maxOutputLength),
  };
}
