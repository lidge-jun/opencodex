import { isDeclaredReasoningEffort } from "../reasoning-effort";

export { DROID_DEFAULT_EFFORT_HEADER } from "../clients/config-export/contracts";

type ChatRequestBody = Record<string, unknown>;

export function applyDroidReasoningDefault(body: ChatRequestBody, header: string | null): void {
  if (!header || !isDeclaredReasoningEffort(header)) return;
  if (Object.hasOwn(body, "reasoning_effort")) return;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
    && Object.hasOwn(reasoning, "effort")) return;
  body.reasoning_effort = header;
}
