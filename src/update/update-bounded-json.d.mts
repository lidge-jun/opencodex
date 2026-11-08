export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Parses data only: callers must separately validate schema and authority. */
export function parseBoundedJson(bytes: Uint8Array, maxBytes: number): JsonValue;
