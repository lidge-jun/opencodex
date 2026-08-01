# 007 — Investigation: #290 / #288 `spawn_agent` boundary

- Date: 2026-07-23 KST
- Tree: `codex/issue-triage-260723` at `origin/dev`
- Issues: [#290](https://github.com/lidge-jun/opencodex/issues/290), [#288](https://github.com/lidge-jun/opencodex/issues/288)
- Upstream source check: `openai/codex` commit
  [`0f9fb40f`](https://github.com/openai/codex/tree/0f9fb40fa9c4cc4b1ed0d595ce3ba70468a0c87a),
  read 2026-07-23 KST
- Scope: investigation only; no `src/`, `tests/`, GUI, GitHub, or git-state mutation

## Executive conclusions

| Issue | Classification | Short conclusion |
| --- | --- | --- |
| #288 | **Mixed boundary, configuration/current behavior rather than an OpenCodex routing bug** | OpenCodex supplies catalog order and `multi_agent_version`; Codex performs the pre-proxy validation. In base/default mode, routed Ark rows are unpinned while Sol/Terra are V2-pinned, which explains the two-name error. Force V2 for routed overrides; feature Ark separately only if it should be advertised among the first five. |
| #290 | **Needs a boundary capture; likely upstream-surface or model/provider tool-call compatibility, with an OpenCodex `{}` finalization step** | OpenCodex preserves the received tool schema and non-empty argument deltas on the ordinary Responses-to-chat path. It does deliberately serialize a tool call with no received argument bytes as `{}`. The missing evidence is whether the parent received an empty schema, whether the custom model emitted no arguments, or whether a provider-specific translation dropped them. |

## Evidence anchors

All technical conclusions below point back to these verbatim source anchors.

### E1 — fresh/default config seeds five native models

`src/config.ts:556-564`:

> `Default featured subagent models (native GPT) seeded on a fresh install and when \`subagentModels\` is unset.`
>
> `Codex's spawn_agent advertises the first 5 featured catalog entries`
>
> `export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];`

`src/config.ts:731-750`:

> `export function getDefaultConfig(): OcxConfig {`
>
> `subagentModels: [...DEFAULT_SUBAGENT_MODELS],`

There is one important loading nuance. A valid pre-existing/manual config that omits
`subagentModels` is returned directly rather than merged with defaults.
`src/config.ts:600-618`:

> `const result = configSchema.safeParse(parsed);`
>
> `if (result.success) return result.data as OcxConfig;`
>
> `const defaults = getDefaultConfig();`
>
> `const merged = { ...defaults, ...parsed };`

Thus “without touching `subagentModels`” means a native five-model seed on a normal fresh
config, but can mean an empty featured list on an older/manual valid config. This nuance does
not change #288's V2 backend gate described in E4/E5.

### E2 — featured routed slugs are supported and receive the lowest priorities

`src/codex/catalog.ts:1091-1095`:

> `Codex's models-manager sorts by \`priority\` ASC and advertises the first 5 picker-visible`
>
> `models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5).`
>
> `This works for native gpt slugs AND routed slugs alike.`

`src/codex/catalog.ts:1106-1125`:

> `for (const m of goModels) {`
>
> `const slug = catalogModelSlug(m);`
>
> `const e = deriveEntry(`
>
> `` `Routed via opencodex → ${m.provider} (${m.owned_by ?? m.provider}).`, ``
>
> `5,`
>
> `const rankHit = rank.get(slug) ?? rank.get(\`${m.provider}/${m.id}\`);`
>
> `if (rankHit !== undefined) e.priority = rankHit;`

Therefore a routed Ark slug **can** be placed in the advertised first five, but only when it is
chosen in `subagentModels`; merely adding the provider does not replace the fresh native seed.

### E3 — sync uses `config.subagentModels` as the catalog feature list

`src/codex/catalog.ts:2181-2189`:

> `Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)`
>
> `const featured = config.subagentModels ?? [];`
>
> `const orderedGoModels = orderForSubagents(enabledGo, featured);`
>
> `const goEntries = buildCatalogEntries(... orderedGoModels, featured, ... multiAgentMode, ...);`

The management surface makes this an explicit, capped user choice.
`src/server/management-api.ts:1191-1201`:

> `return jsonResponse({ chosen: config.subagentModels ?? [], available });`
>
> `const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 5) : [];`
>
> `config.subagentModels = chosen;`
>
> `await refreshCodexCatalogBestEffort();`

### E4 — base mode preserves only upstream V2 pins; forced V2 stamps every row

`src/codex/catalog.ts:545-570`:

> `"default": RESTORE upstream pins`
>
> `"v2": force multi_agent_version = "v2" on ALL entries`
>
> `const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);`
>
> `if (typeof upstreamPin === "string") {`
>
> `entry.multi_agent_version = upstreamPin;`
>
> `} else {`
>
> `delete entry.multi_agent_version;`
>
> `for (const entry of entries) {`
>
> `entry.multi_agent_version = mode;`

The pinned local snapshot identifies Sol and Terra as V2 and Luna as V1.
`src/codex/data/upstream-models.json:4-21`, `:118-135`, `:230-247`:

> `"slug": "gpt-5.6-sol"`
>
> `"multi_agent_version": "v2"`

> `"slug": "gpt-5.6-terra"`
>
> `"multi_agent_version": "v2"`

> `"slug": "gpt-5.6-luna"`
>
> `"multi_agent_version": "v1"`

A fresh pure-function projection on this tree produced the following relevant rows:

```text
base/default: gpt-5.5@0 none, sol@1 v2, terra@2 v2, luna@3 v1,
              gpt-5.4-mini@4 none, Ark/glm-5.2@5 none
forced v2:   the same priorities, but every row including Ark/glm-5.2 is v2
```

Proof command:

```bash
bun -e 'import { buildCatalogEntries } from "./src/codex/catalog.ts"; import { DEFAULT_SUBAGENT_MODELS } from "./src/config.ts"; /* project base and v2 rows */'
```

### E5 — Codex owns the rejection, but validates OpenCodex-supplied catalog metadata

Pinned upstream `codex-rs/core/src/tools/handlers/multi_agents_common.rs:31-39`:

> `pub(crate) const MAX_SPAWN_AGENT_MODEL_OVERRIDES: usize = 5;`
>
> `multi_agent_version != MultiAgentVersion::V2`
>
> `|| model.multi_agent_version == Some(multi_agent_version)`

Pinned upstream `codex-rs/core/src/tools/handlers/multi_agents_common.rs:397-421`:

> `.find(|model| {`
>
> `model.model == requested_model`
>
> `&& model_supports_multi_agent_backend(model, multi_agent_version)`
>
> `.filter(|model| model.show_in_picker)`
>
> `.filter(|model| model_supports_multi_agent_backend(model, multi_agent_version))`
>
> `.take(MAX_SPAWN_AGENT_MODEL_OVERRIDES)`
>
> `"Unknown model \`{requested_model}\` for spawn_agent. Available models: {available}"`

This proves two distinct rules:

1. An explicit model is accepted if it exists **anywhere** in the loaded model list and its
   `multi_agent_version` supports the active backend. It does not need to be in the printed five.
2. The error suffix prints only the first five picker-visible, backend-compatible rows.

The literal `Unknown model ... for spawn_agent` sentence is upstream Codex text, not text emitted
by OpenCodex. Its membership is nevertheless derived from the OpenCodex-injected catalog.

## #288 analysis — accepted-model enforcement boundary

### What happens without `subagentModels` customization

On a normal fresh config, E1 + E2 + E3 place the native seed ahead of every ordinary routed row.
In base/default multi-agent mode, E4 leaves `Ark/glm-5.2` without a V2 pin. E5 then rejects the
explicit Ark override before any child request reaches OpenCodex. Backend filtering removes the
unpinned `gpt-5.5` and `gpt-5.4-mini` rows and the V1-pinned Luna row from the V2 error list, leaving
Sol and Terra. That is why the reported two-name membership is explainable by OpenCodex's catalog
plus Codex's V2 filter.

The observed order `terra, sol` is not reproduced by current `origin/dev`'s default priorities
(`sol` precedes `terra` in E1/E4). That order can come from the reporter's persisted
`subagentModels`, stale `models_cache.json`, or their installed-version catalog. The membership is
explained; the exact order requires the reporter's actual catalog rows.

For an older/manual valid config with no `subagentModels` field, E1's load nuance and E3 yield an
empty feature list. Routed models can then participate in ordinary catalog ordering, but base mode
still leaves Ark unpinned, so E5 still excludes it from a V2 override. The native-only seed is
therefore an **advertising/order cause**, not the decisive acceptance gate; the decisive #288 gate
is `multi_agent_version`.

### Boundary classification

**Mixed / OpenCodex-influenced.** The enforcement exception and error string run in Codex before
proxy routing (E5), but OpenCodex controls the model row, visibility, priority, and V2 pin that the
enforcer consumes (E2-E4). This is not “purely app-side,” and it is not evidence that the Ark data
plane cannot route the model.

### Definitive #288 reproduction evidence

A decisive report needs all of the following from the same new Codex session:

- Codex Desktop/CLI and OpenCodex versions.
- `ocx v2 status` output and the persisted `multiAgentMode` value.
- `GET /api/subagent-models` (`chosen` and `available`).
- Sanitized catalog rows for `Ark/glm-5.2`, `Ark/ark-code-latest`, Sol, Terra, and Luna containing
  only `slug`, `priority`, `visibility`, and `multi_agent_version`.
- Proof that the mode change completed catalog sync and that a **new** session was opened, followed
  by one explicit override and one inheritance control.
- Confirmation that no `/v1/responses` child request reached OpenCodex for the rejected override;
  that distinguishes the Codex validation gate from provider routing.

Expected discriminator: base mode rejects an unpinned Ark row; `ocx v2 mode v2` stamps the row V2
and should let E5 find the exact model even if it is outside the printed first five. Adding Ark to
`subagentModels` is separately required only to advertise it in those first five.

## #290 analysis — custom parent emits empty `spawn_agent` arguments

### The V2 contract exists upstream

Pinned upstream `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:102-145`:

> `let mut properties = spawn_agent_common_properties_v2(&options.agent_type_description);`
>
> `properties.insert(`
>
> `"task_name".to_string(),`
>
> `parameters: JsonSchema::object(`
>
> `properties,`
>
> `Some(vec!["task_name".to_string(), "message".to_string()]),`

Pinned upstream `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:631-639`:

> `"message".to_string(),`
>
> `JsonSchema::string(Some(`
>
> `"Initial plain-text task for the new agent.".to_string(),`
>
> `.with_encrypted(),`

Pinned upstream `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:49-58`, `:173-184`:

> `let arguments = function_arguments(payload)?;`
>
> `let args: SpawnAgentArgs = parse_arguments(&arguments)?;`
>
> `let message = message_content(args.message)?;`

> `#[serde(deny_unknown_fields)]`
>
> `struct SpawnAgentArgs {`
>
> `message: String,`
>
> `task_name: String,`

The reported `missing field message at line 1 column 2` is therefore the parent tool call failing
at the upstream Codex argument parse, before child creation.

### Incoming Responses schema to routed-provider request

OpenCodex reads collaboration definitions from both normal `tools` and the Responses Lite
`additional_tools` input shape. `src/responses/parser.ts:100-123`:

> `parameters: (t.parameters ?? {}) as Record<string, unknown>,`
>
> `if (t.type === "function" && typeof t.name === "string") {`
>
> `pushFn(t);`
>
> `} else if (t.type === "namespace" && Array.isArray(t.tools)) {`
>
> `if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") pushFn(inner, ns);`

`src/responses/parser.ts:271-279`, `:530-547`:

> `if (effectiveType === "additional_tools") {`
>
> `if (Array.isArray(at.tools)) loadedToolSpecs.push(...at.tools);`

> `const declaredTools = buildTools(data.tools as unknown[] | undefined) ?? [];`
>
> `const loadedTools = buildTools(loadedToolSpecs) ?? [];`
>
> `...(mergedTools.length > 0 ? { tools: mergedTools } : {}),`

The ordinary OpenAI-compatible translation then forwards that same parameter object.
`src/adapters/openai-chat.ts:395-423`:

> `const tools = allowed`
>
> `? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))`
>
> `: parsed.context.tools;`
>
> `parameters,`
>
> `...(t.strict !== undefined ? { strict: t.strict } : {}),`

`src/adapters/openai-chat.ts:495-507`:

> `const tools = toolsToChatFormatForProvider(parsed, provider);`
>
> `if (tools) body.tools = tools;`

There is no `spawn_agent`-specific deletion of `message`, `task_name`, `properties`, or `required`
on this path. Provider adapters can sanitize unsupported JSON-Schema annotations. For example,
Gemini drops Codex's `encrypted` annotation but preserves the requirement; the regression assertion
is verbatim at `tests/google-tool-schema.test.ts:32-55`:

> `required: ["message"],`
>
> `expect(props.message.encrypted).toBeUndefined();`
>
> `expect(props.message.type).toBe("string");`
>
> `expect(out.required).toEqual(["message"]);`

However, the repository also contains a live-capture fixture in which Responses Lite supplied
empty parameter objects for all collaboration tools. `tests/multi-agent-compat.test.ts:123-145`:

> `responses_lite WS shape: tools inside input additional_tools are seen (real Codex Desktop capture)`
>
> `{ type: "namespace", name: "collaboration", description: "...", tools: [`
>
> `{ type: "function", name: "spawn_agent", description: "...", parameters: {} },`

OpenCodex faithfully forwarding `{}` in that input shape gives a custom parent no public argument
contract to follow. The issue report does not include the inbound request, so this upstream-surface
hypothesis cannot yet be separated from a model that ignored a complete schema.

### Upstream model output to Codex Responses output

For streamed OpenAI-compatible responses, OpenCodex accumulates the provider's argument bytes
without parsing or rewriting them. `src/adapters/openai-chat.ts:590-599`, `:664-683`:

> `interface PendingToolCall { key: string; id: string; name: string; args: string }`
>
> `if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };`

> `if (tc.function?.arguments) call.args += tc.function.arguments;`

The Responses bridge preserves every non-empty delta but deliberately makes a zero-byte call valid
JSON by substituting `{}`. `src/bridge.ts:342-375`:

> `Empty input ... must serialize as`
>
> `"{}", never ""`
>
> `const argsStr = currentToolCall.args || "{}";`
>
> `arguments: argsStr, status: "completed",`

`src/bridge.ts:525-553`:

> `currentToolCall = { ... args: "", ... };`
>
> `currentToolCall.args += event.arguments;`
>
> `delta: event.arguments,`

The non-streaming bridge has the same fallback at `src/bridge.ts:843-848`:

> `arguments: currentToolCallArgs || "{}", status: "completed",`

Thus OpenCodex **can be the component that materializes the literal `{}`**, but only after the
adapter reported a tool-call start/end with no argument bytes. Current code does not show a path
that converts a non-empty `message`/`task_name` JSON argument string into `{}`. The replay parser
also defaults empty/non-JSON historical calls to `{}` (`src/responses/parser.ts:400-412`), but that
happens on the following request and does not explain the first malformed parent emission.

### #290 versus #92

They fail at different times and carry different missing data:

| Issue | Last successful step | Failure point | Missing data |
| --- | --- | --- | --- |
| #290 | Routed parent selects/calls the `spawn_agent` tool name | Parent output reaches Codex as `{}` or incomplete JSON; `SpawnAgentArgs` parse fails before a child exists (upstream `spawn.rs:49-58,173-184`) | Public tool arguments, especially `message` and `task_name` |
| #92 | Native parent emits a valid spawn; Codex creates the routed child | Child's later `NEW_TASK` request reaches OpenCodex with an empty plaintext payload and genuine Fernet `encrypted_content` | Plaintext task body after successful spawn |

The local #92 boundary preserves real ciphertext by design. `src/server/responses.ts:342-370`:

> `Genuine backend blobs are left byte-identical`
>
> `if (!looksLikeBackendCiphertext(payload)) {`
>
> `node.splice(i, 1, ...parts);`

And routed parsing treats encrypted tool-result content as opaque.
`src/responses/parser.ts:193-195`:

> `codex-rs FunctionCallOutputContentItem::EncryptedContent — opaque to routed models.`
>
> `parts.push({ type: "text", text: "[encrypted content omitted]" });`

Therefore #290 must not be merged into #92: #290 is schema/model-output/bridge territory before
spawn; #92 is an unreadable child-input payload after spawn.

### Definitive #290 reproduction evidence

One controlled run must capture four sanitized boundaries, preserving tool names, schema keys, and
argument strings while removing prompts, credentials, headers, and unrelated content:

1. **Codex → OpenCodex request:** the exact `spawn_agent` entry from top-level `tools` or
   `input[].additional_tools`, including `properties`, `required`, `encrypted`, namespace, and
   `tool_choice`.
2. **OpenCodex → provider request:** the translated `spawn_agent` tool definition and tool choice.
3. **Provider → OpenCodex raw response:** every `tool_calls[].function.{name,arguments}` fragment
   (or the provider-native equivalent) for the failed call, before adapter parsing.
4. **OpenCodex → Codex response:** `response.function_call_arguments.delta`,
   `response.function_call_arguments.done`, and final `response.output_item.done.item.arguments`,
   plus Codex stderr's parse error and retry count.

Controls must use the same prompt and schema with: native parent, the failing custom parent, one
known tool-capable custom model, streaming and non-streaming if supported, and a trivial required
argument function alongside `spawn_agent`. Existing OpenCodex debug logging intentionally does not
capture full request bodies, so `ocx debug provider on` alone is not definitive; use a local
sanitized harness or temporary maintainer instrumentation, never post credentials or full prompts.

The classification decision is mechanical:

- Inbound schema already `{}` → upstream Codex/Desktop surface issue; label `upstream-tracking`.
- Inbound full, outbound schema damaged → OpenCodex adapter bug; keep `bug` and add a regression.
- Outbound full, provider raw arguments empty/`{}` → model/provider tool-call capability; label
  `provider-compatibility`, document support, and close unless a supported-provider regression.
- Provider raw arguments non-empty, emitted Responses arguments empty → OpenCodex bridge bug; keep
  `bug` and add byte-preservation coverage.

## Verdict

- **#288: mixed boundary, OpenCodex-influenced, not upstream-only.** OpenCodex controls the catalog
  rows and V2 pins; Codex enforces them before proxy routing. Base mode's Sol/Terra-only V2 pins
  explain the reported available membership. This can move to **bucket 1 (answer/configuration +
  close)** because forced V2 is the existing supported control; re-open only if a freshly synced
  `Ark/*` row marked `multi_agent_version: "v2"` is still rejected.
- **#290: needs-repro, likely upstream-surface or provider/model compatibility; not #92.** OpenCodex
  does materialize `{}` for a call with zero received argument bytes, but no inspected path erases
  non-empty arguments. Keep open until the four-boundary capture identifies where the bytes vanish.

## Recommended direction

### #288 response

Reply in Chinese, label `question` + `provider-compatibility`, and close as configuration/current
behavior after giving this workaround:

> 这个错误文本由 Codex 客户端生成，但候选模型来自 OpenCodex 注入的 catalog。默认/base
> 模式只保留上游 V2 pin，因此当前只有 `gpt-5.6-sol` / `gpt-5.6-terra` 通过 V2
> `spawn_agent` 校验；普通 `Ark/*` catalog 行没有 V2 pin。请运行 `ocx v2 mode v2`，确认
> catalog 同步完成后新建 Codex 会话再测试。若希望 Ark 模型同时出现在工具描述的前五个
> 候选中，再把它加入 Dashboard 的 Sub-agents 列表（`subagentModels`）；一旦该行已标记
> `multi_agent_version: "v2"`，显式精确 ID 的校验并不要求它必须位于前五。省略 `model`
> 继续是继承父模型的可用方案。若强制 V2 后仍失败，请附上脱敏后的 `ocx v2 status`、
> `/api/subagent-models`，以及 Ark/Sol/Terra catalog 行的 `slug/priority/visibility/multi_agent_version`。

### #290 response

Keep open with `needs-info` + `provider-compatibility`; do **not** add `upstream-tracking` until the
inbound schema capture proves the Codex surface supplied `{}`. Recommended response:

> Current `dev` preserves the received `spawn_agent` parameter schema through the normal
> Responses-to-chat translation and preserves non-empty provider argument deltas on the way back.
> It does normalize a tool call that contains zero argument bytes to `{}` so that the Responses
> item remains valid JSON. We therefore need one sanitized four-boundary capture: incoming
> `spawn_agent` schema, outgoing provider schema, raw provider tool-call arguments, and emitted
> Responses argument events. That will distinguish an empty Codex `additional_tools` schema, a
> model/provider structured-tool limitation, and an OpenCodex translation defect. This is separate
> from #92: #290 fails before child creation, while #92 loses the task after a valid spawn. Until
> the capture is available, use `ocx v2 mode v1` for heterogeneous/custom-model delegation; if no
> model override is required, inheriting the parent model is another control, not proof of V2
> structured-call support.

If the capture identifies an inbound empty schema, cross-link a new/existing upstream Codex issue
and switch #290 to `upstream-tracking`. If it identifies a provider raw `{}`, retain only
`provider-compatibility` and document the incompatible model. If it identifies OpenCodex damage,
retain `bug` and implement the narrow adapter/bridge regression fix.

## Effort estimate

- **#288:** Small, 30–60 minutes for maintainer response, reporter verification, labels, and close;
  no production change expected. Add 30 minutes only if the existing docs need a direct Ark example.
- **#290 capture:** Medium, 3–5 hours to build/run a privacy-safe four-boundary harness across one
  failing and one known-good custom model and record the matrix.
- **#290 fix after capture:** 2–4 hours if it is a local schema/bridge defect; 1–2 hours for a
  provider-compatibility documentation/diagnostic change; external/unknown if upstream Codex must
  preserve or expand the V2 schema.
