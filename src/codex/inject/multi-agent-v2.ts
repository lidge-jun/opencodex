import { readFileSync } from "node:fs";
import type { OcxConfig } from "../../types";
import { ConfigWriteDestinationChanged, type LockHandle } from "../config-write-lock";
import { CODEX_CONFIG_PATH } from "../paths";
import type { CodexCliSelectionAsyncParentWrite } from "../cli-update-selection-gate";

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
  | { ok: false; message: string; retryable?: boolean };

let toggleForTests: ((enabled: boolean, env: NodeJS.ProcessEnv, validateBeforeSpawn: () => void) => void) | undefined;

/** Test seam: substitute the native `codex features` toggle so no Codex runtime is required. */
export function setCodexMultiAgentV2ToggleForTests(
  toggle: ((enabled: boolean, env: NodeJS.ProcessEnv, validateBeforeSpawn: () => void) => void) | undefined,
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
  /** Acquire before the config lock; an already-v1 home needs no selection lease. */
  admit(): Promise<boolean>;
  release(): void;
  /**
   * `heldConfigWriteLock` is the injector's own held write-lock handle: the
   * transition would otherwise re-acquire the same file and refuse itself.
   */
  run(heldConfigWriteLock?: LockHandle): InjectedV1SurfaceReconcile;
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
    toggle = (enabled, env, validate) => runCodexFeaturesCommand(enabled ? "enable" : "disable", "multi_agent_v2", env, validate);
  }
  const resolvedToggle = toggle;
  const { beginCodexCliSelectionParentWriteAsync, CodexCliSelectionMutationBusyError } = await import("../cli-update-selection-gate");
  let selection: CodexCliSelectionAsyncParentWrite | undefined;
  const busy = (): InjectedV1SurfaceReconcile => ({
    ok: false, retryable: true,
    message: "Codex config injection refused: the v1 transition has no current CLI selection admission. Retry the injection after the CLI update finishes.",
  });
  return {
    enabledAtPrepare,
    async admit() {
      if (!enabledAtPrepare) return true;
      if (selection) return selection.entered;
      selection = await beginCodexCliSelectionParentWriteAsync();
      return selection.entered;
    },
    release() { selection?.exit(); },
    run(heldConfigWriteLock) {
      // Decide on the bytes present NOW, under the lock — the prepare-time
      // answer is stale the moment another writer could have touched the file.
      if (!isMultiAgentV2Enabled()) {
        return { ok: true, content: readFileSync(CODEX_CONFIG_PATH, "utf-8"), changed: false };
      }
      // A prepare-time no-op may have become a transition. Refuse without a child;
      // a fresh pass can acquire admission before taking the config lock.
      if (!selection?.entered) return busy();
      let transition: ReturnType<typeof transitionMultiAgentV2>;
      try {
        transition = selection.commit(() => transitionMultiAgentV2(false, resolvedToggle, {
          ...(heldConfigWriteLock !== undefined ? { heldConfigWriteLock } : {}),
        }));
      } catch (error) {
        if (error instanceof CodexCliSelectionMutationBusyError) return busy();
        throw error;
      }
      if (!transition.ok) {
        if (transition.retryable === false) throw new ConfigWriteDestinationChanged(transition.error);
        return {
          ok: false,
          message: `Codex config injection refused: could not reconcile the v1 surface with the global multi_agent_v2 feature: ${transition.error}.`,
        };
      }
      return { ok: true, content: readFileSync(CODEX_CONFIG_PATH, "utf-8"), changed: transition.changed };
    },
  };
}
