import { fetchM365ModelRoster } from "../../providers/m365-copilot-discovery-fetch";
import { jsonResponse } from "../auth-cors";
import type { OAuthAccessSnapshot } from "../../oauth";
import type { OcxProviderConfig } from "../../types";

export async function probeM365CopilotProvider(name: string, provider: OcxProviderConfig, auth: OAuthAccessSnapshot | undefined, signal: AbortSignal) {
  const started = Date.now();
  try {
    const models = await fetchM365ModelRoster(name, provider, auth, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    return jsonResponse({ ok: true, latencyMs: Date.now() - started, models: models.length, message: "Connected. " + models.length + " account models." });
  } catch {
    return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: "Microsoft 365 Copilot live discovery failed. Check the account and sign in again if the web session expired." });
  }
}
