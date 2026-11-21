// Requests behind the price dialog's catalog refresh and relay-multiplier controls.
import { readJsonOrThrow } from "../fetch-json";
import { isRecord } from "./model-price-cost";

const MAX_MULTIPLIER = 1000;

/** Forces a refresh of the online price catalogs; throws when the receipt is invalid or every source failed. */
export async function postPricingRefresh(apiBase: string, signal: AbortSignal): Promise<void> {
  const result = await readJsonOrThrow<unknown>(await fetch(`${apiBase}/api/pricing/refresh`, { method: "POST", signal }));
  signal.throwIfAborted();
  if (!isRecord(result) || result.ok !== true) throw new Error("invalid pricing refresh receipt");
  const statuses = isRecord(result.sources) ? Object.values(result.sources) : [];
  if (statuses.length > 0 && statuses.every(status => isRecord(status) && status.ok === false)) throw new Error("price catalogs unavailable");
}

/** Saves (or with null clears) a provider's relay multiplier; throws unless the receipt echoes it. */
export async function putPriceMultiplier(apiBase: string, provider: string, multiplier: number | null, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase}/api/providers/${encodeURIComponent(provider)}/price-multiplier`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiplier }), signal,
  });
  const result = await readJsonOrThrow<unknown>(response);
  signal.throwIfAborted();
  if (!isRecord(result) || result.ok !== true || result.provider !== provider || result.multiplier !== multiplier) {
    throw new Error("invalid price-multiplier receipt");
  }
}

export function parseMultiplierDraft(draft: string): number | null | "invalid" {
  const text = draft.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value <= MAX_MULTIPLIER ? value : "invalid";
}
