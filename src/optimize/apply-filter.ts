import type { FilterFunction } from "./types";

export function safeApply(fn: FilterFunction, text: string): string {
  if (typeof fn !== "function") return text;
  try {
    const out = fn(text);
    if (typeof out !== "string") return text;
    return out;
  } catch (err) {
    const name = (fn as unknown as { filterName?: string }).filterName || fn.name || "anonymous";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[RTK] filter '${name}' failed, passing through raw: ${errMsg}`);
    return text;
  }
}
