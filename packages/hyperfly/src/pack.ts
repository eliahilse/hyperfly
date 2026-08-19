import type { PackHooks } from "./codec.js";

interface ZlibLike {
  deflateRawSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
  inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}

/**
 * node:zlib resolved at runtime so the module stays importable in browsers,
 * where packing needs explicit hooks (DecompressionStream is async and cannot
 * back the sync codec API).
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

export function defaultPackHooks(): PackHooks {
  const zlib = builtinZlib();
  if (!zlib) return {};
  return {
    deflate: (data) => new Uint8Array(zlib.deflateRawSync(data, { level: 6 })),
    inflate: (data, maxOutputLength) => {
      // cap one past the declared size so an over-long stream throws rather than allocating freely
      const out = zlib.inflateRawSync(data, { maxOutputLength: maxOutputLength + 1 });
      // node's sync inflater silently ignores bytes after the final block; a tight stream
      // breaks when its last byte is dropped, a padded one does not — reject the padded case
      if (data.length > 0) {
        let tight = false;
        try {
          zlib.inflateRawSync(data.subarray(0, data.length - 1), { maxOutputLength: maxOutputLength + 1 });
        } catch {
          tight = true;
        }
        if (!tight) throw new Error("trailing bytes after the deflate stream");
      }
      return new Uint8Array(out);
    },
  };
}
