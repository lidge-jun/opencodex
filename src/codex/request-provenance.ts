export type CodexRequestProvenance = {
  role: "main" | "subagent" | "unknown";
  purpose: "turn" | "compaction" | "helper" | "unknown";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function codexRequestTurn(body: unknown, headers: Headers): { threadId: string; turnId: string } | undefined {
  const raw = record(body);
  const client = record(raw?.client_metadata);
  const threadId = headers.get("thread-id")?.trim();
  const turnId = client?.turn_id;
  if (raw?.generate === false || !threadId || client?.thread_id !== threadId
    || typeof turnId !== "string" || !turnId.trim()) return;
  return { threadId, turnId };
}

export function codexRequestProvenance(
  body: unknown,
  headers: Headers,
  options: { transport?: "websocket"; internalHelper?: boolean } = {},
): CodexRequestProvenance {
  const unknown: CodexRequestProvenance = { role: "unknown", purpose: "unknown" };
  if (options.internalHelper) return { role: "unknown", purpose: "helper" };
  const raw = record(body);
  const client = record(raw?.client_metadata);
  if (raw && Object.hasOwn(raw, "client_metadata") && !client) return unknown;
  const copies: unknown[] = [];
  const header = headers.get("x-codex-turn-metadata");
  if (options.transport !== "websocket" && header !== null) copies.push(header);
  if (client && Object.hasOwn(client, "x-codex-turn-metadata")) copies.push(client["x-codex-turn-metadata"]);
  let verdict: CodexRequestProvenance | undefined;
  for (const copy of copies) {
    if (typeof copy !== "string") return unknown;
    let metadata: Record<string, unknown> | undefined;
    try { metadata = record(JSON.parse(copy)); } catch { return unknown; }
    if (!metadata) return unknown;
    const purpose = metadata.request_kind === "turn" ? "turn"
      : metadata.request_kind === "compaction" ? "compaction" : "helper";
    const role = metadata.subagent_kind === "thread_spawn" ? "subagent"
      : metadata.thread_source === "user" ? "main" : "unknown";
    const next: CodexRequestProvenance = { role, purpose };
    if (verdict && (verdict.role !== role || verdict.purpose !== purpose)) return unknown;
    verdict = next;
  }
  const subagent = headers.get("x-openai-subagent");
  const own = headers.get("thread-id")?.trim();
  const parent = headers.get("x-codex-parent-thread-id")?.trim();
  if (subagent === "collab_spawn" || (own && parent && own !== parent)) {
    return { role: "subagent", purpose: verdict?.purpose ?? "unknown" };
  }
  if (subagent && subagent !== "compact" && !(options.transport === "websocket" && verdict)) {
    return { role: "unknown", purpose: "helper" };
  }
  return verdict ?? unknown;
}
