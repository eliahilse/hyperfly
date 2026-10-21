export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function marker(value: object, key: string): string | undefined {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key ? (value as Record<string, string>)[key] : undefined;
}

/** Turns the vector markers {"$bytes": "<hex>"} and {"$surrogate": "<hex>"} into a Uint8Array and a lone surrogate. */
export function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const bytes = marker(value, "$bytes");
    if (bytes !== undefined) return fromHex(bytes);
    const surrogate = marker(value, "$surrogate");
    if (surrogate !== undefined) return String.fromCharCode(parseInt(surrogate, 16));
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, revive(inner)]));
  }
  return value;
}
