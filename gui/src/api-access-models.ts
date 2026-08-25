export interface ExternalModelRow {
  id: string;
  displayName: string;
  provider: string;
  disabled?: boolean;
  native?: boolean;
  custom?: boolean;
}

/** The inbound wires a client can speak to this proxy. */
export type GatewayInboundProtocol = "responses" | "chat" | "messages";

/** Inbound gateway protocols — not inferred from provider type. */
export function gatewayInboundProtocols(claudeCodeEnabled: boolean): GatewayInboundProtocol[] {
  return claudeCodeEnabled
    ? ["responses", "chat", "messages"]
    : ["responses", "chat"];
}

/**
 * Classify a `/v1/models` row. Bare IDs keep their callable id; the explicit
 * combo marker takes precedence over the compatibility-oriented `owned_by`.
 */
export function classifyExternalModel(row: {
  id: string;
  owned_by?: string;
  is_combo?: boolean;
}): ExternalModelRow {
  const slashIndex = row.id.indexOf("/");
  const ownedBy = typeof row.owned_by === "string" && row.owned_by.trim()
    ? row.owned_by.trim()
    : undefined;
  const provider = row.is_combo === true
    ? "combo"
    : slashIndex > 0
    ? row.id.slice(0, slashIndex)
    : (ownedBy ?? "openai");
  const native = slashIndex < 0 && provider === "openai";
  const custom = provider !== "openai" && provider !== "combo";
  return {
    id: row.id,
    displayName: row.id,
    provider,
    native,
    custom,
  };
}

export function externalModelId(model: ExternalModelRow): string {
  return model.id;
}
