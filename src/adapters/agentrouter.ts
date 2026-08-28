export const AGENTROUTER_LANGUAGE_PREAMBLE =
  "[Instruction: Process the user request below and respond in the appropriate language.]";

/** Match only AgentRouter itself or one of its subdomains, never a lookalike hostname. */
export function isAgentRouterEndpoint(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "agentrouter.org" || hostname.endsWith(".agentrouter.org");
  } catch {
    return false;
  }
}

/** Supply AgentRouter's stable Codex admission identity unless the operator set one. */
export function agentRouterDefaultHeaders(
  baseUrl: string,
  configuredHeaders?: Record<string, string>,
): Record<string, string> {
  if (!isAgentRouterEndpoint(baseUrl)) return {};
  const hasOriginator = Object.keys(configuredHeaders ?? {}).some(name => name.toLowerCase() === "originator");
  return hasOriginator ? {} : { originator: "codex_cli_rs" };
}

/** Prepend the compatibility marker as a distinct block on the first user turn. */
export function applyAgentRouterLanguageFraming(messages: unknown[]): void {
  const firstUser = messages.find(
    (message): message is { role: string; content: unknown } =>
      typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user",
  );
  if (!firstUser) return;
  const preamble = { type: "text", text: AGENTROUTER_LANGUAGE_PREAMBLE };
  if (typeof firstUser.content === "string") {
    firstUser.content = firstUser.content === ""
      ? [preamble]
      : [preamble, { type: "text", text: firstUser.content }];
    return;
  }
  if (!Array.isArray(firstUser.content)) return;
  const [head] = firstUser.content as { type?: unknown; text?: unknown }[];
  if (head?.type === "text" && head.text === AGENTROUTER_LANGUAGE_PREAMBLE) return;
  (firstUser.content as unknown[]).unshift(preamble);
}

/** Frame only an owned copy so translated and passthrough callers remain unchanged. */
export function frameAgentRouterMessages(baseUrl: string, messages: unknown): unknown {
  if (!isAgentRouterEndpoint(baseUrl) || !Array.isArray(messages)) return messages;
  const copy = structuredClone(messages) as unknown[];
  applyAgentRouterLanguageFraming(copy);
  return copy;
}
