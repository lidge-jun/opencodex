export class AnthropicRequestError extends Error {}

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
