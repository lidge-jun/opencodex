# Hosted-Tool Denials

## Declared hosted-tool denials

The explicitly selected Codex Responses Lite ordinary unreferenced history projection follows [hosted-search continuation binding](../providers-and-adapters.md#hosted-search-continuation-binding): it changes historical cells, not hosted tool declarations or action capability.
A gateway that speaks the Responses API does not necessarily accept everything OpenAI accepts.
`unsupportedHostedTools` is how such a destination says so: it names the hosted tool declarations
this provider rejects, and `stripUnsupportedHostedTools` in
`src/adapters/openai-responses/tool-schema.ts` removes them from `tools`, from client-loaded
`additional_tools`, and from `tool_choice` before the body is serialized.

The capability is provider-declared rather than destination-matched, and that is the point. The
original mechanism in `src/responses/hosted-tool-policy.ts` was a table of `(model, baseUrl)`
predicates, so a narrower gateway could only be supported by shipping a proxy release naming its
endpoint. The reported destination (#5002) accepted plain Responses requests and `function` tools
but rejected hosted `web_search` with HTTP 400 `unsupported_request`, which meant a text-only
prompt failed before the model answered, because Codex's hosted declaration travelled with it. A
provider nobody has classified can now describe itself in config.

The declaration is additive to that table, not a replacement for it. The table is for destinations that reject a tool regardless of configuration, so an operator who never heard of the field stays protected;
a declaration can only deny more, never re-enable a known-broken pairing. The table denies `web_search` and `web_search_preview` for `xiaomimimo.com` and its subdomains, including the public API and token-plan hosts (#5501), independent of model name. Matching uses the parsed URL hostname, so unrelated hosts with MiMo names in paths or queries are unaffected.
OpenCode Go keeps hosted search: it refuses two OpenAI-private fields rather than the tool, and `src/adapters/xai-web-search.ts` normalizes those fields for every Grok model there.

Two properties are deliberate. Spelling variants of one capability are aliased, so declaring
`web_search` also denies `web_search_preview` — the rest of the proxy already folds that pair into
a single tool, and honouring only the spelling the operator happened to write would reproduce the
original 400 while the config claimed to have prevented it. And the value is validated against a
closed vocabulary in `src/config/schema/leaf-validators.ts` and `src/server/auth-cors.ts`, because
the provider schema ends in `.passthrough()`: an unvalidated misspelling would be persisted and
then match no tool, leaving the operator with the upstream rejection this field exists to prevent
and nothing explaining why. That is the `codexToolMode` lesson from #2106.

This capability is independent of `supportsResponsesCustomTools`, which denies native `custom`
tools and `custom_tool_call` items. A gateway that rejects both sets both; neither implies the
other.

### Conditional denial with client tools

`unsupportedHostedToolsWithClientTools` describes a narrower incompatibility: the destination
serves a hosted tool alone and function calling alone, but rejects a request that declares both.
The reported gateway (#8204) fronts Gemini behind an OpenAI-compatible Responses endpoint and
answers HTTP 400 for hosted search plus a function tool, while hosted search by itself completes
with real search events. The unconditional list was a workaround that also removed that working
search-only capability.

`stripUnsupportedHostedTools` asks `responsesBodyDeclaresClientTools` in
`src/responses/hosted-tool-policy.ts` whether the body declares a `function` or `custom` tool,
or a namespace with such members, in `tools`, in an `additional_tools` catalog, or in a
`tool_search_output` result. Only then does `declaredUnsupportedHostedTools` fold the
conditional list into the same alias-expanded set the unconditional list builds, so every filter
and selector reconciliation that follows is shared: a forced `tool_choice` naming a stripped tool
becomes `"none"`, and `allowed_tools` loses the entry. Hosted declarations never count as client
tools, so the strip cannot change its own condition. The scan runs only for a provider that set the
field; every other provider keeps the byte-identical body.

The unconditional list stays authoritative, because the union can only deny more. The value uses
the same closed vocabulary and validation as the unconditional list, and a same-destination
dashboard save carries both lists (`PROVIDER_COMPAT_CARRY_FIELDS` in
`src/server/management/provider-overwrite-carry.ts`). They travel together: keeping only the
conditional list would let a hosted-only request forward a tool the dropped unconditional list
denied. `modelPreferHostedTools` cannot name a tool either list denies. Codex turns always carry
client tools, so a conditional denial would strip the hosted tool after the preference had
already removed the client `image_gen` declaration, leaving the turn with neither;
`modelPreferHostedToolsConfigError` rejects the pair for both lists.
