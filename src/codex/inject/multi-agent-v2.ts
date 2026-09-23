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
  | { ok: true; content: string; changed: boolean }
  | { ok: false; message: string };

let toggleForTests: ((enabled: boolean) => void) | undefined;

/** Test seam: substitute the native `codex features` toggle so no Codex runtime is required. */
export function setCodexMultiAgentV2ToggleForTests(
  toggle: ((enabled: boolean) => void) | undefined,
): void {
  toggleForTests = toggle;
}

/**
 * A reconcile whose dependencies are resolved ahead of the Codex write lock.
 *
 * The write-lock commit callback is synchronous, so the dynamic imports and the
 * toggle seam are settled in `prepareInjectedV1SurfaceReconcile` before
 * acquisition. `run()` is the synchronous half and must be called while the
 * coordinated write boundary is held: the transition mutates config.toml and a
 * caller that lets it escape the boundary leaves the file changed when a later
 * step refuses.
 */
export interface PreparedV1SurfaceReconcile {
  /**
   * Whether the on-disk flag was enabled when the prepare ran. A pre-lock hint
   * only — `run()` re-checks the flag on the bytes present under the lock.
   */
  readonly enabledAtPrepare: boolean;
  run(): InjectedV1SurfaceReconcile;
}

/**
 * Resolve the reconcile for a v1 injection, or null when none can apply.
 *
 * Read-only preflight and non-v1 modes are pass-throughs, and externally owned
 * provider configs never reach this point — the caller returns before
 * preparing. Resolve the native toggle before the lock even when the flag is
 * currently off: another writer may enable it before the under-lock re-read.
 */
export async function prepareInjectedV1SurfaceReconcile(
  config: Pick<OcxConfig, "multiAgentMode"> | undefined,
  options: { validateOnly?: boolean },
): Promise<PreparedV1SurfaceReconcile | null> {
  if (options.validateOnly || config?.multiAgentMode !== "v1") {
    return null;
  }
  const { isMultiAgentV2Enabled, transitionMultiAgentV2 } = await import("../features");
  const enabledAtPrepare = isMultiAgentV2Enabled();
  let toggle = toggleForTests;
  if (!toggle) {
    const { runCodexFeaturesCommand } = await import("../../cli/v2");
    toggle = enabled => runCodexFeaturesCommand(enabled ? "enable" : "disable");
  }
  const resolvedToggle = toggle;
  return {
    enabledAtPrepare,
    run() {
      // Decide on the bytes present NOW, under the lock — the prepare-time
      // answer is stale the moment another writer could have touched the file.
      if (!isMultiAgentV2Enabled()) {
        return { ok: true, content: readFileSync(CODEX_CONFIG_PATH, "utf-8"), changed: false };
      }
      const transition = transitionMultiAgentV2(false, resolvedToggle);
      if (!transition.ok) {
        return {
          ok: false,
          message: `Codex config injection refused: could not reconcile the v1 surface with the global multi_agent_v2 feature: ${transition.error}.`,
        };
      }
      return { ok: true, content: readFileSync(CODEX_CONFIG_PATH, "utf-8"), changed: transition.changed };
    },
  };
}
