export const MIRRORABLE_COLLABORATION_OPERATIONS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function catalogLists(body: unknown, replayPrefixLength: number): unknown[][] {
  if (!isRecord(body)) return [];
  const lists: unknown[][] = [];
  if (Array.isArray(body.tools)) lists.push(body.tools);
  if (!Array.isArray(body.input)) return lists;
  const start = Math.max(0, Math.min(replayPrefixLength, body.input.length));
  for (const item of body.input.slice(start)) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) lists.push(item.tools);
  }
  return lists;
}
