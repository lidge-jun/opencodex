# 000 — PR #536 rework: current state and evidence

Date: 2026-07-27
Session: 019fa2b1-c6e6-7b40-a8b8-387c8d164c07
Goalplan slug: `reopen-opencodex-pr-536-lucinegogo-feat-glm-prov`

## The pull request as it stands

`gh pr view 536 --json state,baseRefName,headRefName,isCrossRepository,maintainerCanModify`:

- number: 536, state: `CLOSED`, base: `main`, head: `Lucinegogo:feat/glm-provider`
- head sha: `26e518407f092f443826f396ede3d626cc6af271`
- cross repository: `true`, `maintainerCanModify`: **false**
- files: `src/providers/registry.ts` (+23/-0), `tests/provider-registry-parity.test.ts` (+1/-1)

`maintainerCanModify: false` is the operational fact that shapes this whole plan.
We cannot push a corrected commit onto the contributor's fork branch, so the
corrected implementation lands as our own commits on `dev` with the contributor
credited, and the PR is reopened as the conversation thread where that is
explained.

## What the contributor proposed

A `glm` entry in `PROVIDER_REGISTRY` targeting
`https://open.bigmodel.cn/api/paas/v4`, `adapter: openai-chat`,
`authKind: key`, `defaultModel: glm-4.6`, `liveModels: true`,
`thinkingToggleModels: ["glm-4.6"]` reusing `THINKING_TOGGLE_EFFORTS` /
`THINKING_TOGGLE_MAP`, plus `models: ["glm-4.6", "glm-4.5", "glm-4-plus",
"glm-4-air", "glm-4-airx", "glm-4-flash", "glm-4-flashx", "glm-4-long",
"glm-4v"]`. The test change appends `"glm"` to `EXPECTED_KEY_PROVIDER_IDS`.

The underlying idea is right and worth having: the domestic BigModel
pay-as-you-go endpoint is a different host and a different billing product from
the existing `zai` coding-plan preset, and nothing in the tree serves it today
as a first-class registry provider.

## Blockers, verified against the tree

### B1 — the `glm` id is already taken (release blocker)

`src/providers/free-directory.ts:106`:

```ts
glm: openAi("https://api.z.ai/api/coding/paas/v4", "https://z.ai/manage-apikey/apikey-list", { ... }),
```

`src/router.ts:188` `routedProviderConfig()` resolves a saved provider against
`PROVIDER_REGISTRY` by id, and at `src/router.ts:233-236`:

```ts
const baseUrl = (registryBaseUrlIsTemplate || registryEntry.allowBaseUrlOverride) && userBaseUrlIsResolved
  ? userBaseUrl
  : registryEntry.baseUrl;
```

The PR entry sets no `allowBaseUrlOverride` and no template placeholders, so a
user who already saved a `glm` provider pointed at `api.z.ai` would, after the
upgrade, silently have that config resolved to `open.bigmodel.cn` — the saved
API key would be sent to a different vendor's host. That is the `UNSAFE` line in
the goal objective, and it is why an unused id is mandatory rather than
cosmetic.

`glm-cn` is also taken (`src/providers/free-directory.ts:107`, pointing at
`https://open.bigmodel.cn/api/coding/paas/v4` — the coding-plan path, not the
pay-as-you-go `paas/v4` path). Chosen id: **`zhipu-bigmodel`**, which appears in
neither list.

### B2 — model list and default do not match the current BigModel lineup

`src/generated/jawcode-model-metadata.ts:51` (`zai` rows) records the current GLM
families: `glm-4.6` (204800), `glm-4.6v` (128000, text+image), `glm-4.7`
(204800), `glm-4.7-flash` (200000), `glm-5` (204800), `glm-5.1` (200000),
`glm-5.2` (1000000), `glm-5v-turbo` (200000, text+image). The PR's static list is
the older GLM-4 generation (`glm-4-plus`, `glm-4-air`, `glm-4-airx`,
`glm-4-long`, `glm-4v`) with `glm-4.6` as default.

### B3 — no context window, so Codex compacts early

No `modelContextWindows` entry and no metadata bundle alias means catalog
normalization falls back to the generic 128,000 window. For `glm-4.6` the
authoritative figure in this repository is 204,800 — roughly 76,800 tokens are
silently thrown away per session.

### B4 — vision ids published as text-only

`glm-4v` in the static list with no `modelInputModalities` entry publishes a
vision model as text-only; Codex then blocks image attachments before they reach
it. Either declare `["text", "image"]` or do not ship the vision id.

### B5 — coverage proves nothing about behavior

Appending `"glm"` to `EXPECTED_KEY_PROVIDER_IDS` asserts that an id exists. It
cannot catch a wrong `baseUrl`, a wrong adapter, a broken thinking-toggle map, or
a regression in `src/adapters/openai-chat.ts:561`, where
`modelInList(provider.thinkingToggleModels, ...)` is what turns a mapped effort
into `thinking: { type }` instead of `reasoning_effort`. AGENTS.md asks for a
focused regression test near the subsystem's existing tests; the model for that
is `tests/tencent-siliconflow-providers.test.ts`.

### B6 — docs never mention the new route

`docs-site/src/content/docs/guides/providers.md:184` lists only
`Z.AI (GLM Coding) | https://api.z.ai/api/coding/paas/v4`. The same table exists
in `ko`, `ja`, `ru`, and `zh-cn`. A user cannot tell the two GLM routes apart
from the docs.

### B7 — wrong target branch

The PR targets `main`. Per AGENTS.md and `MAINTAINERS.md`, contributions go to
`dev`; `main` only moves by maintainer promotion. The bot already prefixed the
title with `[WRONG BRANCH]`.

## Open question carried into 020

`liveModels: true` assumes BigModel publishes an OpenAI-compatible `GET /models`
on `open.bigmodel.cn/api/paas/v4`. That is unverified here and cannot be probed
without a Zhipu key. Treated as `unverified` and resolved conservatively in
`020`: ship a static list from the metadata bundle rather than claim live
discovery we have not seen respond.

## Work-phase map

| Doc | Work phase | Deliverable |
|-----|------------|-------------|
| `010` | `wp2-reopen` | PR #536 reopened, base `dev`, maintainer comment posted |
| `020` | `wp3-registry` | `zhipu-bigmodel` registry entry with complete metadata |
| `030` | `wp4-tests` | Contract + request-shaping regression tests |
| `040` | `wp5-docs` | Provider guide row in `en` + `ko`/`ja`/`ru`/`zh-cn` |
