export class AnthropicRequestError extends Error {}

/** A date-shaped Desktop ID can also name a genuine native model absent from discovery. */
export class DesktopModelMappingUnavailableError extends AnthropicRequestError {
  constructor() {
    super("Claude Desktop model mapping is unavailable; refresh model discovery or reapply the connected hub profile");
  }
}

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
