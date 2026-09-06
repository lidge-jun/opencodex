/** Shared snapshot wire primitives; no retention state or policy. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type RetainedOutputItem = {
  item: Record<string, unknown>;
  sourceBytes: number;
};

export function jsonBlock(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}`;
}
