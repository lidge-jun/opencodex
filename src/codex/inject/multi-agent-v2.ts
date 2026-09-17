import { readFileSync } from "node:fs";
import type { OcxConfig } from "../../types";
import { CODEX_CONFIG_PATH } from "../paths";

/**
 * Reconcile the native `features.multi_agent_v2` override when an injection carries an
 * explicit v1 surface pin.
 *
 * Codex resolves the global v2 feature before catalog-level `multi_agent_version` pins, so a
 * config.toml that still enables `multi_agent_v2` would run v2 sessions under a catalog the
 * injection just stamped v1 — and the child tasks it then produces are undeliverable ciphertext
 * to a v1 reader. Fresh OpenCodex configs write `multiAgentMode: "v1"`, which makes first
 * injection on a previously-v2 Codex home the common trigger. The explicit mode selectors
 * (`ocx v2 mode`, `PUT /api/v2`) already run the same format-preserving transition; this is
 * the injection-side half of that contract.
 */
export type InjectedV1SurfaceReconcile =
  | { ok: true; content: string }
  | { ok: false; message: string };

let toggleForTests: ((enabled: boolean) => void) | undefined;

/** Test seam: substitute the native `codex features` toggle so no Codex runtime is required. */
export function setCodexMultiAgentV2ToggleForTests(
  toggle: ((enabled: boolean) => void) | undefined,
): void {
  toggleForTests = toggle;
}

/**
 * Disable a pre-existing global v2 override before the journal baseline when the injected
 * OpenCodex config explicitly selects v1. Returns the config.toml bytes the caller should keep
 * working from: unchanged input when no transition ran, re-read post-transition bytes when it
 * did. Read-only preflight and non-v1 modes are pass-throughs, and externally owned provider
 * configs never reach this point — the caller returns before invoking it.
 */
export async function reconcileInjectedV1Surface(
  config: Pick<OcxConfig, "multiAgentMode"> | undefined,
  options: { validateOnly?: boolean },
  rawContent: string,
): Promise<InjectedV1SurfaceReconcile> {
  if (options.validateOnly || config?.multiAgentMode !== "v1") {
    return { ok: true, content: rawContent };
  }
  const { isMultiAgentV2Enabled, transitionMultiAgentV2 } = await import("../features");
  if (!isMultiAgentV2Enabled()) return { ok: true, content: rawContent };
  let toggle = toggleForTests;
  if (!toggle) {
    const { runCodexFeaturesCommand } = await import("../../cli/v2");
    toggle = enabled => runCodexFeaturesCommand(enabled ? "enable" : "disable");
  }
  const transition = transitionMultiAgentV2(false, toggle);
  if (!transition.ok) {
    return {
      ok: false,
      message: `Codex config injection refused: could not reconcile the v1 surface with the global multi_agent_v2 feature: ${transition.error}.`,
    };
  }
  return { ok: true, content: readFileSync(CODEX_CONFIG_PATH, "utf-8") };
}
