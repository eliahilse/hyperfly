import { HyperflyError } from "./errors.js";
import type { IRNode } from "./ir.js";

export const MAX_ARTIFACT_NESTING = 512;

export function checkArtifactDepth(depth: number): void {
  if (depth > MAX_ARTIFACT_NESTING) {
    throw new HyperflyError("ir", `artifact nests deeper than ${MAX_ARTIFACT_NESTING}`);
  }
}

/** Canonical IR starts at depth 2; a struct's fields array and field objects add two containers. */
export function checkIRNesting(ir: IRNode): void {
  let node = ir;
  let depth = 2;
  let stack: [IRNode, number][] | undefined;
  for (;;) {
    while (node && typeof node === "object") {
      checkArtifactDepth(depth);
      if (node.kind === "array" || node.kind === "nullable") {
        node = node.kind === "array" ? node.element : node.inner;
        depth++;
        continue;
      }
      if (node.kind === "enum") checkArtifactDepth(depth + 1);
      if (node.kind === "struct") {
        checkArtifactDepth(depth + 1);
        if (Array.isArray(node.fields)) {
          if (node.fields.length > 0) checkArtifactDepth(depth + 3);
          for (const field of node.fields) {
            const type = field?.type;
            if (!type || typeof type !== "object") continue;
            if (type.kind === "enum") checkArtifactDepth(depth + 4);
            else if (type.kind === "struct" || type.kind === "array" || type.kind === "nullable") {
              (stack ??= []).push([type, depth + 3]);
            }
          }
        }
      }
      break;
    }
    if (!stack?.length) return;
    [node, depth] = stack.pop()!;
  }
}
