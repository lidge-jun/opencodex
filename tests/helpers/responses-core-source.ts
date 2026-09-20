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
  "request-prepare.ts",
  "compaction-routing.ts",
  "request-transport.ts",
  "request-sidecar-auth.ts",
  "response-effects.ts",
  "request-send-budget.ts",
  "request-spend.ts",
  "passthrough-execution.ts",
  "passthrough-dispatch.ts",
  "reset-replay.ts",
  "passthrough-delivery.ts",
  "sidecar-execution.ts",
  "completion-policy.ts",
  "run-turn-execution.ts",
  "adapter-dispatch.ts",
  "adapter-continuation.ts",
  "adapter-delivery.ts",
] as const;

export type ResponsesCoreModule = typeof RESPONSES_CORE_MODULES[number];

export function readResponsesCoreModule(name: ResponsesCoreModule): string {
  return readFileSync(repoPath("src", "server", "responses", name), "utf8");
}

/** Preserve cross-site source assertions without reading only the thin facade. */
export function readResponsesCoreSource(): string {
  return RESPONSES_CORE_MODULES.map(readResponsesCoreModule).join("\n");
}
