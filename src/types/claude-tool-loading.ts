/**
 * Tool-loading settings of the Claude Code inbound (`claudeCode.*`). `OcxClaudeCodeConfig` in
 * ./config extends this interface, so every reader still sees one `claudeCode` block; the fields
 * live here because they share one contract (data-planes/claude-tool-loading.md).
 */
export interface OcxClaudeCodeToolLoadingConfig {
  /**
   * Opt-in resolved provider/model routes verified to accept Responses additional_tools.
   * A single trailing '*' matches a provider-qualified prefix (for example 'gateway/gpt-*').
   * Replays successful client ToolSearch discoveries in place without growing the initial
   * catalog. Requires metadata.user_id. Absent/empty is off; native passthrough is unchanged.
   * Applies only after routing settles on a direct openai-responses route; combos and policies are skipped.
   */
  appendOnlyToolLoadingModels?: string[];
  /**
   * Opt-in direct openai-chat routes (same selector syntax, validation and skips): the catalog
   * carries one stable `use_loaded_tool` dispatcher across ToolSearch loads, loaded definitions
   * ride the ToolSearch result as text, and dispatcher calls are rewritten to the named tool
   * before the client sees them. Absent/empty is off and byte-identical to an unset key.
   */
  chatToolDispatchModels?: string[];
  /**
   * Opt-in ENABLE_TOOL_SEARCH injection for launched Claude Code sessions (#4838).
   *
   * Claude Code v2.1.304+ turns tool search on by default behind an
   * ANTHROPIC_BASE_URL gateway; earlier versions keep it off there unless
   * ENABLE_TOOL_SEARCH is true / auto / auto:N (#7963). Unset leaves the client's
   * default; `false` injects nothing either, so a user who wants upfront loading
   * exports ENABLE_TOOL_SEARCH=false themselves.
   *
   * Default OFF. Native Anthropic passthrough retains server-side search; the
   * ordinary translated route drops the typed search tool and sends function schemas
   * eagerly. appendOnlyToolLoadingModels (verified final Responses destinations) and
   * chatToolDispatchModels (verified direct Chat routes) are separate opt-ins for an
   * eager client-executed ToolSearch function: they keep currently declared deferred
   * definitions out of the initial catalog and project them at successful discovery
   * results. This launcher switch alone enables neither projection nor server-side search.
   * Compatibility-enforcement admission remains unchanged and can reject unsupported
   * tool_search/tool_reference/deferred_tools requests; no native-search parity or
   * cache-hit guarantee is implied.
   *
   * `true` injects "true"; a string is passed through verbatim so Claude Code's own
   * vocabulary (`auto`, `auto:N`, `force`) stays reachable. `false` and absent
   * inject nothing — they do not force the variable off, because a value the
   * operator exported themselves always wins.
   */
  toolSearch?: boolean | string;
}
