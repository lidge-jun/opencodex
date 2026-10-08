import type { OcxConfig } from "../../types";
import type { AnthropicAccountPoolConfig } from "../../types/anthropic-account-pool";
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../../providers/anthropic-instance";
import { rawAnthropicAccountPool, resolveAnthropicAccountPoolConfig } from "../../oauth/anthropic-pool-config";
import { readConfigFileSnapshot, validateConfigCandidate } from "../../config/diagnostics";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import { mutatePersistedConfig } from "../../config";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { jsonResponse } from "../auth-cors";

/** Required instance; never synthesizes a deleted B provider row. */
export function writeAnthropicPoolSettings(config: OcxConfig, instance: AnthropicInstanceId, value: AnthropicAccountPoolConfig): void {
  if (instance === "anthropic") config.anthropicAccountPool = value;
  else {
    const row = config.providers[instance];
    if (!configuredAnthropicInstance(config, instance)) throw new Error("Anthropic pool instance is no longer configured");
    row!.anthropicAccountPool = value;
  }
}

/**
 * Both Anthropic writers share publication-aware recovery from the atomic mutation owner.
 * Recovery covers only the durable write. Once the file holds the new value, a stale live row
 * or a failed reconcile is reported as saved with the fixed bookkeeping warning, never a 500.
 */
export function persistAnthropicPoolPatch(
  config: OcxConfig,
  instance: AnthropicInstanceId,
  patch: (target: OcxConfig) => { changed: boolean; value: NonNullable<OcxConfig["anthropicAccountPool"]> },
): { status: "saved"; warning?: "config_bookkeeping_failed" } | { status: "failed"; response: Response } {
  const before = readConfigFileSnapshot();
  const unknown = () => ({ status: "failed" as const, response: jsonResponse({
    error: "Pool settings save state is unknown; reload settings before editing again",
    code: "config_save_state_unknown",
  }, 409) });
  const publish = (value: AnthropicAccountPoolConfig, warned: boolean): { status: "saved"; warning?: "config_bookkeeping_failed" } => {
    let warning = warned;
    try { writeAnthropicPoolSettings(config, instance, value); } catch { warning = true; }
    try { reconcileLiveStateStores(); } catch { warning = true; }
    return warning ? { status: "saved", warning: "config_bookkeeping_failed" } : { status: "saved" };
  };
  let durable: AnthropicAccountPoolConfig | undefined;
  try {
    const saved = mutatePersistedConfig(target => {
      if (instance === "anthropic2" && !configuredAnthropicInstance(target, instance)) {
        throw new Error("Anthropic pool instance is no longer configured");
      }
      return patch(target);
    });
    if (saved.status === "unavailable") return unknown();
    durable = saved.value;
  } catch (error) {
    const persisted = readConfigFileSnapshot();
    if (persisted.diagnostics.source !== "file" || persisted.raw === undefined) return unknown();
    // File reads may salvage hand edits; recovery success requires a strict, authoritative document.
    let validated: ReturnType<typeof validateConfigCandidate>;
    try { validated = validateConfigCandidate(JSON.parse(persisted.raw.replace(/^\uFEFF/, ""))); }
    catch { return unknown(); }
    if (!validated.ok) return unknown();
    const current = validated.config;
    if (instance === "anthropic2" && !configuredAnthropicInstance(current, instance)) return unknown();
    let expected: AnthropicAccountPoolConfig;
    try { expected = patch(structuredClone(current)).value; } catch { return unknown(); }
    const matches = JSON.stringify(rawAnthropicAccountPool(current, instance)) === JSON.stringify(expected);
    // A failed live write or reconcile must not turn confirmed publication back into a rollback.
    if (matches) return publish(resolveAnthropicAccountPoolConfig(current, instance), true);
    if (error instanceof ConfigWritePublishedError || persisted.raw !== before.raw) return unknown();
    return { status: "failed", response: jsonResponse({ error: "Pool settings could not be saved" }, 500) };
  }
  if (durable === undefined) return unknown();
  return publish(durable, false);
}
