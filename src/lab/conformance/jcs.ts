/** RFC 8785 JSON Canonicalization Scheme (JCS) for deterministic equality. */

function assertValidUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("jcsStringify: lone UTF-16 surrogate is not valid Unicode");
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("jcsStringify: lone UTF-16 surrogate is not valid Unicode");
    }
  }
}

function stringifyJcsString(value: string): string {
  assertValidUnicodeScalarString(value);
  return JSON.stringify(value);
}

function assertDenseJsonArray(value: readonly unknown[]): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError("jcsStringify: sparse arrays / array holes are not representable in JCS");
    }
  }
  for (const key of Object.keys(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError("jcsStringify: arrays with extra enumerable properties are not representable in JCS");
    }
  }
}

export function jcsStringify(value: unknown): string {
  if (value === undefined) throw new TypeError("jcsStringify: undefined is not representable in JCS");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("jcsStringify: non-finite numbers are not representable in JCS");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return stringifyJcsString(value);
  if (Array.isArray(value)) {
    assertDenseJsonArray(value);
    return `[${value.map(jcsStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("jcsStringify: only plain JSON objects are representable in JCS");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${stringifyJcsString(key)}:${jcsStringify(obj[key])}`).join(",")}}`;
  }
  throw new TypeError(`jcsStringify: unsupported value type ${typeof value}`);
}

export function jcsEqual(a: unknown, b: unknown): boolean {
  return jcsStringify(a) === jcsStringify(b);
}
