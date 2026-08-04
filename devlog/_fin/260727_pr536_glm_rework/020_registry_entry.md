# 020 — The `zhipu-bigmodel` registry entry

Work phase: `wp3-registry` · Criteria: `c3-registry`, `c5-typecheck`

## Id decision

`zhipu-bigmodel`. Checked against both namespaces:

- `PROVIDER_REGISTRY` (`src/providers/registry.ts`) — no `zhipu*` row exists.
- `FREE_PROVIDER_ACCESS_GROUPS` / `FREE_PROVIDER_DIRECTORY`
  (`src/providers/free-directory.ts:16,106,107`) — `glm` and `glm-cn` are taken,
  `zhipu-bigmodel` is not.

Both checked namespaces matter because `routedProviderConfig()` looks up only
`PROVIDER_REGISTRY`, but a saved config can be seeded from either list — that
asymmetry is exactly how the `glm` collision would have hijacked a Z.AI endpoint.

Rejected alternatives: `glm-cn` (already bound to the coding-plan path on the
same host, so reusing it would create the same silent-retarget bug one level
down) and `bigmodel` (the label users see is Zhipu's, and `zhipu-` reads as a
vendor namespace we can extend later).

## Placement

Immediately after the `zai` entry (`src/providers/registry.ts:776-787`), so the
two GLM routes sit together and the comment above them can explain the split.

## Entry shape

```ts
// Zhipu's domestic BigModel platform: OpenAI-compatible pay-as-you-go on
// open.bigmodel.cn, a different host and billing product from the `zai`
// coding-plan subscription above. The id is deliberately NOT `glm`/`glm-cn`:
// both are taken in FREE_PROVIDER_DIRECTORY, and routedProviderConfig() would
// silently retarget a saved config's baseUrl to this host.
// Evidence: docs.bigmodel.cn/api-reference (chat completions),
// docs.bigmodel.cn/cn/guide/models/text/glm-4.6 (thinking toggle).
{
  id: "zhipu-bigmodel",
  label: "Zhipu AI — BigModel",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
  defaultModel: "glm-4.6",
  models: ZHIPU_BIGMODEL_MODELS,
  jawcodeBundle: "zai",
  modelContextWindows: { "glm-4.6": 204_800 },
  modelInputModalities: ZHIPU_BIGMODEL_INPUT_MODALITIES,
  thinkingToggleModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
  modelReasoningEfforts: Object.fromEntries(
    ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS]),
  ),
  modelReasoningEffortMap: Object.fromEntries(
    ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP]),
  ),
  preserveReasoningContentModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
  note: "Domestic BigModel pay-as-you-go endpoint (open.bigmodel.cn)",
},
```

Constants placed next to the existing GLM constants near
`src/providers/registry.ts:170-181`:

```ts
const ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS = ["glm-4.6", "glm-4.7", "glm-5", "glm-5.1"];
const ZHIPU_BIGMODEL_TEXT_MODELS = ["glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1"];
const ZHIPU_BIGMODEL_MODELS = [...ZHIPU_BIGMODEL_TEXT_MODELS, "glm-4.6v"];
const ZHIPU_BIGMODEL_INPUT_MODALITIES: Record<string, string[]> = {
  ...Object.fromEntries(ZHIPU_BIGMODEL_TEXT_MODELS.map(id => [id, ["text"]])),
  "glm-4.6v": ["text", "image"],
};
```

## Why each field

**`defaultModel: glm-4.6`** — keeps the contributor's choice. It is the widely
available BigModel default and it is the model their thinking-toggle claim was
researched against.

**`models`** — replaces the GLM-4 generation list with ids the repository already
has metadata for (`src/generated/jawcode-model-metadata.ts:51`). Shipping
`glm-4-plus`/`glm-4-airx`/`glm-4-long` would advertise a picker of models we
have no context/modality facts for.

**`jawcodeBundle: "zai"`** — `deriveJawcodeAliases()`
(`src/providers/derive.ts:261`) maps the provider id onto a metadata bundle, and
the `zai` bundle already carries every id above with authoritative context
windows and modalities. This is what B3 asked for, done by connecting the
existing bundle rather than transcribing numbers by hand. `modelContextWindows`
still declares `glm-4.6: 204_800` explicitly so the default model's window is
correct even when bundle lookup is bypassed.

**`modelInputModalities` (and deliberately no `noVisionModels`)** — `glm-4.6v` is
the vision member; everything else is text-only. See `001` §A3: in this
repository `noVisionModels` is a vision-sidecar routing claim that makes the
catalog *add* image input (`src/codex/catalog/provider-fetch.ts:98-105`), not a
capability denial. We have not verified sidecar coverage for BigModel-hosted GLM,
so the entry declares modalities directly and lists nothing under
`noVisionModels`.

**`thinkingToggleModels` and the effort maps** — the wire contract at
`src/adapters/openai-chat.ts:561-570` only emits `thinking: { type }` when the
model is in `thinkingToggleModels` AND the mapped effort is
`enabled`/`disabled`/`adaptive`. `THINKING_TOGGLE_MAP` maps
`none|minimal|low -> disabled` and `medium|high|xhigh|max -> enabled`, which is
the binary GLM exposes. Without `modelReasoningEffortMap` the raw Codex effort
would fall through to `reasoning_effort`, which these models reject.

**No `liveModels`** — deliberately dropped from the contributor's version. We
have not observed `GET https://open.bigmodel.cn/api/paas/v4/models` respond, and
a false `liveModels: true` produces an empty or failing picker at runtime. The
static list plus the metadata bundle is the honest default; flipping it on later
is a one-line change once someone with a Zhipu key confirms the endpoint. This is
the open question from `000`, resolved conservatively and called out in the PR
comment as the item the contributor can close.

## Commit

```
feat(providers): add the Zhipu BigModel provider under a non-colliding id

Co-authored-by: Lucinegogo <103441383+Lucinegogo@users.noreply.github.com>
```

## Verification

- `bun run typecheck`
- `bun test tests/provider-registry-parity.test.ts` (id uniqueness + derived maps)
