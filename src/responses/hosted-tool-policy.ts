/**
 * Hosted tools rejected by specific native model slugs or exact provider destinations.
 *
 * Currently empty. Its only row removed hosted web search for grok-4.6 on OpenCode Go, but that
 * destination rejects two OpenAI-private fields rather than the tool: the xAI web-search
 * normalizer in `src/adapters/xai-web-search.ts` now removes those fields for every Grok model
 * there, and search works. Add a row only for a destination that refuses the tool itself.
 */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{
  match: (model: string, baseUrl?: string) => boolean;
  tools: ReadonlySet<string>;
}> = [];

/**
 * Hosted-tool declaration names an operator may list in `unsupportedHostedTools`.
 *
 * A gateway must be able to deny anything a client can send it, so this is the set of
 * nameless hosted/private declaration types the proxy recognizes on a Responses request.
 * It is deliberately a closed vocabulary: the provider config schema ends in
 * `.passthrough()`, so an unvalidated misspelling would be accepted, persisted, and then
 * silently strip nothing -- which is the exact 400 the operator set the field to avoid
 * (the `codexToolMode` lesson in #2106).
 */
export const DECLARABLE_HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use_preview",
  "computer_use",
  "code_interpreter",
  "image_generation",
  "image_gen",
  "mcp",
  "tool_search",
  "local_shell",
  "x_search",
]);

/**
 * Spellings that name one capability. Declaring either member denies both, because the
 * rest of the proxy already treats these as a single tool: the parser folds
 * `web_search_preview` onto one name (`src/responses/parser-tools.ts`), Chat ingress
 * accepts the pair together (`src/chat/inbound.ts`), and the canonical-field strip lists
 * the pair in a single `toolTypes` set
 * (`src/adapters/openai-responses/request-strips.ts`).
 *
 * Without the alias a capability declaration would be honoured for the spelling the
 * operator happened to write and ignored for the one the client happened to send, which
 * reproduces the original rejection while the config claims to have prevented it.
 */
const HOSTED_TOOL_ALIAS_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["web_search", "web_search_preview"]),
  new Set(["image_generation", "image_gen"]),
  new Set(["computer_use_preview", "computer_use"]),
];

const NO_DECLARED_HOSTED_TOOLS: ReadonlySet<string> = new Set();

/**
 * Expand a provider's declared denials through the alias groups once per request, so the
 * per-tool predicate stays a set lookup. Returns a shared empty set when the provider
 * declares nothing, keeping the common path allocation-free.
 */
export function declaredUnsupportedHostedTools(
  provider?: { unsupportedHostedTools?: readonly string[] },
): ReadonlySet<string> {
  const declared = provider?.unsupportedHostedTools;
  if (!Array.isArray(declared) || declared.length === 0) return NO_DECLARED_HOSTED_TOOLS;
  const out = new Set<string>();
  for (const raw of declared) {
    if (typeof raw !== "string") continue;
    const tool = raw.trim();
    if (!tool) continue;
    out.add(tool);
    for (const group of HOSTED_TOOL_ALIAS_GROUPS) {
      if (!group.has(tool)) continue;
      for (const alias of group) out.add(alias);
    }
  }
  return out.size > 0 ? out : NO_DECLARED_HOSTED_TOOLS;
}

/**
 * True when forwarding this hosted tool to the model would be rejected upstream.
 *
 * `declaredUnsupported` is the provider's own capability declaration, expanded by
 * `declaredUnsupportedHostedTools`. It is additive to the built-in table rather than a
 * replacement for it: the table covers destinations that reject a tool regardless of how
 * the operator configured them, so an operator who never heard of the field stays
 * protected.
 */
export function isHostedToolUnsupportedForModel(
  modelId: string,
  tool: string,
  baseUrl?: string,
  declaredUnsupported?: ReadonlySet<string>,
): boolean {
  if (declaredUnsupported?.has(tool)) return true;
  return UNSUPPORTED_HOSTED_TOOLS.some(entry => entry.match(modelId, baseUrl) && entry.tools.has(tool));
}
