const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  conversationId?: string;
}

const states = new Map<string, StoredResponseState>();

function now(): number {
  return Date.now();
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) states.delete(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    states.delete(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  return {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  if (!responseId) return undefined;
  pruneResponses();
  return states.get(responseId)?.conversationId;
}

export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown },
  conversationId?: string,
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  if (request.store === false) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status !== undefined && response.status !== "completed") return;
  const hasClientToolCall = response.output.some(item => {
    return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
  });
  states.set(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    ...(conversationId && !hasClientToolCall ? { conversationId } : {}),
  });
  pruneResponses();
}

export function clearResponseStateForTests(): void {
  states.clear();
}
