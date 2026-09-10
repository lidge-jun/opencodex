import { isValidProviderName } from "./provider-name";

/** Display preferences only: exact routing and provider entitlements remain authoritative. */
export function isCodexAccountPickerModels(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.entries(value).every(([selector, models]) =>
    isValidProviderName(selector) && Array.isArray(models)
    && models.every(model => typeof model === "string"
      && /^(?:gpt-|codex-)[A-Za-z0-9._-]+$/.test(model)));
}
