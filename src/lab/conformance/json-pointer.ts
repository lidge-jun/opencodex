/** RFC 6901 JSON Pointer resolution for assertion selectors. */

export type PointerResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "selector_missing" | "selector_type_mismatch" };

function decodeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(root: unknown, pointer: string): PointerResult {
  if (!pointer.startsWith("/")) return { ok: false, reason: "selector_missing" };
  if (pointer === "/") return { ok: true, value: root };
  const tokens = pointer.slice(1).split("/").map(decodeToken);
  let current: unknown = root;
  for (const token of tokens) {
    if (token === "-") return { ok: false, reason: "selector_missing" };
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { ok: false, reason: "selector_missing" };
      const index = Number(token);
      if (index >= current.length) return { ok: false, reason: "selector_missing" };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") {
      return { ok: false, reason: "selector_missing" };
    }
    const obj = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, token)) {
      return { ok: false, reason: "selector_missing" };
    }
    current = obj[token];
  }
  return { ok: true, value: current };
}

export function pointerExists(root: unknown, pointer: string): boolean {
  return resolveJsonPointer(root, pointer).ok;
}
