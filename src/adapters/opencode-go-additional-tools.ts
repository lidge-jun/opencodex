function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Console Go accepts public tools but rejects the private additional_tools input wrapper. */
export function normalizeOpenCodeGoAdditionalTools(body: unknown, responseUrl: string): unknown {
  let destination: URL;
  try {
    destination = new URL(responseUrl);
  } catch {
    return body;
  }
  if (destination.origin !== "https://opencode.ai"
    || destination.pathname !== "/zen/go/v1/responses"
    || destination.username || destination.password
    || destination.href.includes("?") || destination.href.includes("#")) return body;
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  // Do not replace a malformed top-level catalog with a partial promoted one.
  if (body.tools !== undefined && !Array.isArray(body.tools)) return body;

  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const item of body.input) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      changed = true;
      // Custom/search/namespace lowering already owns identity and deduplication. This pass
      // only moves declarations, including hosted tools that intentionally have no name.
      for (const tool of item.tools) promoted.push(tool);
    } else {
      input.push(item);
    }
  }
  return changed ? { ...body, input, tools: [...(body.tools ?? []), ...promoted] } : body;
}
