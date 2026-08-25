import type { IRField, IRNode, LiteralValue } from "./ir.js";
import type { SharedProfile } from "./profile.js";
import { sha256 } from "./sha256.js";

/** Spec §5: not generic JSON canonicalization — key order and escaping are fixed here. */
function escapeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp < 0x20) out += `\\u00${cp.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function serializeLiteral(v: LiteralValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return escapeString(v);
}

function serializeField(f: IRField): string {
  let out = `{"name":${escapeString(f.name)},"type":${serializeNode(f.type)}`;
  if (f.optional) out += ',"optional":true';
  if (f.nullable) out += ',"nullable":true';
  return out + "}";
}

export function serializeNode(node: IRNode): string {
  switch (node.kind) {
    case "bool":
    case "float64":
    case "string":
    case "bytes":
      return `{"kind":"${node.kind}"}`;
    case "int": {
      let out = '{"kind":"int"';
      if (node.min !== undefined) out += `,"min":${node.min}`;
      if (node.max !== undefined) out += `,"max":${node.max}`;
      return out + "}";
    }
    case "literal":
      return `{"kind":"literal","value":${serializeLiteral(node.value)}}`;
    case "enum":
      return `{"kind":"enum","members":[${node.members.map(escapeString).join(",")}]}`;
    case "nullable":
      return `{"kind":"nullable","inner":${serializeNode(node.inner)}}`;
    case "array": {
      let out = `{"kind":"array","element":${serializeNode(node.element)}`;
      if (node.length !== undefined) out += `,"length":${node.length}`;
      return out + "}";
    }
    case "struct":
      return `{"kind":"struct","fields":[${node.fields.map(serializeField).join(",")}]}`;
  }
}

export type PlanLayout = "row" | "columnar";

const PLAN_VERSION: Record<PlanLayout, number> = { row: 1, columnar: 4 };

export function serializeShared(shared: SharedProfile): string {
  const columns = shared.columns.map(
    (c) => `{"leaf":${c.leaf},"dict":[${c.dict.map(escapeString).join(",")}]}`,
  );
  return `{"columns":[${columns.join(",")}]}`;
}

export function serializeArtifact(
  ir: IRNode,
  layout: PlanLayout = "row",
  profile?: { shared: SharedProfile },
): string {
  const head = `{"wire":1,"plan":{"layout":"${layout}","version":${PLAN_VERSION[layout]}},"ir":${serializeNode(ir)}`;
  return profile ? `${head},"profile":${serializeShared(profile.shared)}}` : `${head}}`;
}

export function fingerprintOf(artifact: string): Uint8Array {
  return sha256(new TextEncoder().encode(artifact)).slice(0, 16);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
