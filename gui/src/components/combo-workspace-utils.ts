import type { ModelOption, ProviderOption } from "./combo-workspace-types";

export function enabledProviders(providers: ProviderOption[]): ProviderOption[] {
  return providers
    .filter((p) => !p.disabled && !p.hiddenFromPicker)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a number input and clamp to [min, max]. Empty / non-finite values return
 * `undefined` so callers can ignore the keystroke without writing NaN.
 */
export function clampedNumberInput(raw: string, min: number, max: number): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** ChatGPT passthrough has no /models catalog — GPT slugs are listed under provider "openai". */
export function isChatGptForwardOption(p: ProviderOption | undefined): boolean {
  if (!p) return false;
  const id = p.name.toLowerCase();
  if (id !== "openai" && id !== "chatgpt") return false;
  if ((p.authMode ?? "").toLowerCase() !== "forward") return false;
  if ((p.adapter ?? "").toLowerCase() !== "openai-responses") return false;
  const base = (p.baseUrl ?? "").replace(/\/+$/, "");
  return !base || base.includes("chatgpt.com/backend-api/codex");
}

export function modelsForProvider(
  models: ModelOption[],
  provider: string,
  providers: ProviderOption[],
): string[] {
  const keys = new Set<string>([provider]);
  const meta = providers.find((p) => p.name === provider);
  // Alias chatgpt → openai native GPT rows (forward providers don't publish their own catalog).
  if (provider.toLowerCase() === "chatgpt" || isChatGptForwardOption(meta)) {
    keys.add("openai");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (!keys.has(m.provider) || !m.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    ids.push(m.id);
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}
