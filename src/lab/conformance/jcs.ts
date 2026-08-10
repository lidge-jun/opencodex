/** RFC 8785 JSON Canonicalization Scheme (JCS) for deterministic equality. */

export function jcsStringify(value: unknown): string {
  if (value === undefined) throw new TypeError("jcsStringify: undefined is not representable in JCS");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("jcsStringify: non-finite numbers are not representable in JCS");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(jcsStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcsStringify(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`jcsStringify: unsupported value type ${typeof value}`);
}

export function jcsEqual(a: unknown, b: unknown): boolean {
  return jcsStringify(a) === jcsStringify(b);
}
