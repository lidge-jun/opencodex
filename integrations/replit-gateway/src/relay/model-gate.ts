import { isModelAllowed } from "../models";
import type { GatewayErrorCategory } from "../errors";

export function extractRequestModel(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

export type RelayModelGateResult =
  | { ok: true; model: string }
  | { ok: false; category: GatewayErrorCategory };

export function enforceRelayModel(
  body: Uint8Array,
  allowlist: ReadonlySet<string>,
): RelayModelGateResult {
  const model = extractRequestModel(body);
  if (!model || !isModelAllowed(allowlist, model)) {
    return { ok: false, category: "model_not_allowed" };
  }
  return { ok: true, model };
}
