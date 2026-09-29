import { CODEX_REASONING_LEVELS, configuredReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";
import { isPlainObject } from "../lib/plain-data";
import type { OcxProviderConfig } from "../types";

export { DROID_DEFAULT_EFFORT_HEADER } from "../clients/config-export/contracts";

type ChatRequestBody = Record<string, unknown>;
type DroidReasoningTarget = { provider: OcxProviderConfig; modelId: string };

export function droidReasoningDefault(header: string | null): string | undefined {
  return header && isDeclaredReasoningEffort(header) ? header : undefined;
}

function pendingDefault(
  body: ChatRequestBody,
  defaultEffort: string | undefined,
  target: DroidReasoningTarget,
): string | undefined {
  if (!defaultEffort || Object.hasOwn(body, "reasoning_effort")) return undefined;
  if (isPlainObject(body.reasoning) && Object.hasOwn(body.reasoning, "effort")) return undefined;
  const supportedEfforts = configuredReasoningEfforts(target.provider, target.modelId)
    ?? CODEX_REASONING_LEVELS.map(level => level.effort);
  return supportedEfforts.includes(defaultEffort) ? defaultEffort : undefined;
}

export function applyDroidReasoningDefault(
  body: ChatRequestBody,
  defaultEffort: string | undefined,
  target: DroidReasoningTarget,
): void {
  const effort = pendingDefault(body, defaultEffort, target);
  if (effort) body.reasoning_effort = effort;
}

export function applyDroidResponsesReasoningDefault(
  body: unknown,
  defaultEffort: string | undefined,
  target: DroidReasoningTarget,
): boolean {
  if (!isPlainObject(body)) return false;
  const effort = pendingDefault(body, defaultEffort, target);
  if (!effort) return false;
  body.reasoning = { ...(isPlainObject(body.reasoning) ? body.reasoning : {}), effort };
  return true;
}
