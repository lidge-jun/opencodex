import { readFileSync } from "node:fs";
import { repoPath } from "./repo-root";

/**
 * Source-only inventory for cross-owner wiring assertions. Files are read, not
 * executed. responses-core-modules.test.ts compares the inventory to the source import graph.
 */
export const RESPONSES_CORE_MODULES = [
  "core.ts",
  "core-options.ts",
  "native-response-control.ts",
  "native-tool-results.ts",
  "native-response-output.ts",
  "native-response-json.ts",
  "native-injection-protocol.ts",
  "native-injection-replay.ts",
  "native-steering.ts",
  "native-steering-settings.ts",
  "native-steering-policy.ts",
  "native-steering-replay.ts",
  "codex-ws-correlation.ts",
  "core-lifetime.ts",
  "core-replay.ts",
  "core-errors.ts",
  "core-opaque-recovery.ts",
  "core-codex-account.ts",
  "core-combo-failure.ts",
  "core-auth.ts",
  "core-normalize.ts",
  "core-combo.ts",
  "combo-requested-effort.ts",
  "core-combo-native.ts",
  // Reached from core-combo.ts: the JEV model backend's internal decision turn.
  "jev-model-invoke.ts",
  "request-prepare.ts",
  "policy-request-scope.ts",
  "skills-snapshot.ts",
  "shadow-target-availability.ts",
  "compaction-routing.ts",
  "compaction-recovery.ts",
  "compaction-recovery-policy.ts",
  "memory-models.ts",
  "request-transport.ts",
  "request-sidecar-auth.ts",
  "response-effects.ts",
  "request-send-budget.ts",
  "passthrough-execution.ts",
  "passthrough-dispatch.ts",
  "reset-replay.ts",
  "passthrough-delivery.ts",
  "buffered-sse-json.ts",
  "terminal-error-redaction.ts",
  "non-replayable-error.ts",
  "sidecar-execution.ts",
  "completion-policy.ts",
  "run-turn-execution.ts",
  "adapter-dispatch.ts",
  "antigravity-validation-refusal.ts",
  "adapter-continuation.ts",
  "adapter-delivery.ts",
  "policy-refusal.ts",
] as const;

export type ResponsesCoreModule = typeof RESPONSES_CORE_MODULES[number];

export function readResponsesCoreModule(name: ResponsesCoreModule): string {
  return readFileSync(repoPath("src", "server", "responses", name), "utf8");
}

/** Preserve cross-site source assertions without reading only the thin facade. */
export function readResponsesCoreSource(): string {
  return RESPONSES_CORE_MODULES.map(readResponsesCoreModule).join("\n");
}
