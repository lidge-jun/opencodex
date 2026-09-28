import { CODEX_REASONING_LEVELS, configuredReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";
import type { OcxProviderConfig } from "../types";

export { DROID_DEFAULT_EFFORT_HEADER } from "../clients/config-export/contracts";

type ChatRequestBody = Record<string, unknown>;

export function applyDroidReasoningDefault(
  body: ChatRequestBody,
  header: string | null,
  provider: OcxProviderConfig,
  modelId: string,
): void {
  if (!header || !isDeclaredReasoningEffort(header)) return;
  const supportedEfforts = configuredReasoningEfforts(provider, modelId)
    ?? CODEX_REASONING_LEVELS.map(level => level.effort);
  if (!supportedEfforts.includes(header)) return;
  if (Object.hasOwn(body, "reasoning_effort")) return;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
    && Object.hasOwn(reasoning, "effort")) return;
  body.reasoning_effort = header;
}
