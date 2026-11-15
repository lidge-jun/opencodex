/**
 * Hosted tools rejected by specific native model slugs or exact provider destinations.
 *
 * Add a row only for a destination that refuses the tool itself.
 */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{
  match: (model: string, baseUrl?: string) => boolean;
  tools: ReadonlySet<string>;
}> = [
  {
    // MiMo rejects hosted search with "tool type 'web_search' is not supported by this gateway phase" (#5501).
    match: (_model, baseUrl) => {
      if (!baseUrl) return false;
      try {
        return /(?:^|\.)xiaomimimo\.com$/i.test(new URL(baseUrl).hostname);
      } catch {
        return false;
      }
    },
    tools: new Set(["web_search", "web_search_preview"]),
  },
];

/**
 * Hosted-tool declaration names an operator may list in `unsupportedHostedTools` or
 * `unsupportedHostedToolsWithClientTools`.
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

function addDeclaredHostedTools(out: Set<string>, declared: readonly string[] | undefined): void {
  if (!Array.isArray(declared)) return;
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
}

/**
 * Expand a provider's declared denials through the alias groups once per request, so the
 * per-tool predicate stays a set lookup. Returns a shared empty set when the provider
 * declares nothing, keeping the common path allocation-free.
 *
 * `withClientTools` says whether the request being shaped also declares client tools. Only
 * then does `unsupportedHostedToolsWithClientTools` join the unconditional list (#8204);
 * config-time callers leave it false and see the unconditional denials alone.
 */
export function declaredUnsupportedHostedTools(
  provider?: {
    unsupportedHostedTools?: readonly string[];
    unsupportedHostedToolsWithClientTools?: readonly string[];
  },
  withClientTools = false,
): ReadonlySet<string> {
  const declared = provider?.unsupportedHostedTools;
  const conditional = withClientTools ? provider?.unsupportedHostedToolsWithClientTools : undefined;
  const hasDeclared = Array.isArray(declared) && declared.length > 0;
  const hasConditional = Array.isArray(conditional) && conditional.length > 0;
  if (!hasDeclared && !hasConditional) return NO_DECLARED_HOSTED_TOOLS;
  const out = new Set<string>();
  addDeclaredHostedTools(out, declared);
  addDeclaredHostedTools(out, conditional);
  return out.size > 0 ? out : NO_DECLARED_HOSTED_TOOLS;
}

/** A declaration the client executes and answers: a function, a custom tool, or a namespace of them. */
function isClientToolDeclaration(tool: unknown): boolean {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return false;
  const entry = tool as { type?: unknown; tools?: unknown };
  if (entry.type === "function" || entry.type === "custom") return true;
  return entry.type === "namespace" && Array.isArray(entry.tools) && entry.tools.some(isClientToolDeclaration);
}

/**
 * Whether a Responses body declares any client tool the upstream will see: in `tools`, in a
 * client-loaded `additional_tools` catalog, or in the definitions a client-executed
 * `tool_search_output` returned. Hosted declarations never count, so stripping them cannot
 * change the answer.
 */
export function responsesBodyDeclaresClientTools(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.some(isClientToolDeclaration)) return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as { type?: unknown; tools?: unknown };
    return (entry.type === "additional_tools" || entry.type === "tool_search_output")
      && Array.isArray(entry.tools)
      && entry.tools.some(isClientToolDeclaration);
  });
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
