import { readFileSync } from "node:fs";
import { repoPath } from "./repo-root";

/**
 * Source-only inventory for cross-owner wiring assertions. Files are read, not
 * executed. responses-core-modules.test.ts compares the inventory to the source import graph.
 */
export const RESPONSES_CORE_MODULES = [
  "core.ts",
  "core-pipeline.ts",
  "compaction-retention.ts",
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
  "deferred-send-reporter.ts",
  "combo-requested-effort.ts",
  "core-combo-native.ts",
  // Reached from core-combo.ts: tool-loop continuations stay on the lane's previous target (#7298).
  "combo-tool-loop-pin.ts",
  // Reached from core-combo.ts: opt-in JEV session pin keeps a session on its decided target (#7525).
  "jev-session-pin.ts",
  // Reached from core-combo.ts: the JEV model backend's internal decision turn.
  "jev-model-invoke.ts",
  // Reached from core-combo.ts: JEV effort choices and resolved native quota identity.
  "jev-combo-choice.ts",
  "request-prepare.ts",
  "turn-membership.ts",
  "policy-request-scope.ts",
  "skills-snapshot.ts",
  "shadow-target-availability.ts",
  "compaction-routing.ts",
  "main-hard-lock-routing.ts",
  "compaction-recovery.ts",
  "compaction-recovery-policy.ts",
  "memory-models.ts",
  "request-transport.ts",
  // Reached from request-transport.ts: opt-in DeepSeek upload-backed image replay.
  "deepseek-image-files.ts",
  "request-sidecar-auth.ts",
  "response-effects.ts",
  "response-tool-ownership.ts",
  "request-send-budget.ts",
  "account-auto-pause-recovery.ts",
  "passthrough-execution.ts",
  "passthrough-dispatch.ts",
  // Reached from passthrough-dispatch.ts: exact-URL OpenGateway empty-completion recovery.
  "passthrough-completion.ts",
  "opengateway-completion-guard.ts",
  "passthrough-observations.ts",
  "passthrough-key-rotation.ts",
  // Reached from passthrough/adapter dispatch, compact and runTurn: local spend-ledger refusal mapping.
  "spend-storage-error.ts",
  // Reached from passthrough dispatch: local pacing refusals retain 429 and Retry-After.
  "pacing-overload.ts",
  "reset-replay.ts",
  "passthrough-delivery.ts",
  // Reached from passthrough-delivery.ts: buffered combo children must honor a required tool_choice (#7456).
  "combo-required-tool-contract.ts",
  "buffered-sse-json.ts",
  "terminal-error-redaction.ts",
  "non-replayable-error.ts",
  "sidecar-execution.ts",
  "sidecar-send-budget.ts",
  "completion-policy.ts",
  "run-turn-execution.ts",
  "adapter-dispatch.ts",
  "antigravity-validation-refusal.ts",
  "adapter-continuation.ts",
  "adapter-delivery.ts",
  "anthropic-thinking-recovery.ts",
  "advisor-slot.ts",
  "advisor-retention.ts",
  "advisor-plan-slot.ts",
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
