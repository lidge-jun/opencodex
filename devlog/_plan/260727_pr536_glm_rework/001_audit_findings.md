# 001 — Audit of the plan against the tree (A phase, wp1-roadmap)

Four assumptions in `020`/`030` were checked against the actual source. Two held,
two were wrong and are corrected here; both corrections change what gets written.

## A1 — adapter call shape: CORRECTED

`030` sketched `adapter.buildRequest(...)` returning `{ body }` as an object.
`src/adapters/openai-chat.ts:515` declares `buildRequest(parsed: OcxParsedRequest)`
and `tests/adapter-usage.test.ts:48` shows the real usage: it is **async**, takes
a single `OcxParsedRequest`, and `request.body` is a **JSON string** that must be
parsed. The provider is bound at construction via
`createOpenAIChatAdapter(provider)`, not passed to `buildRequest`.

Corrected shape for `030` test 3:

```ts
const adapter = createOpenAIChatAdapter(route.provider);
const request = await adapter.buildRequest({
  modelId: "glm-4.6",
  context: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  options: { reasoning: "high" },
});
const body = JSON.parse(request.body) as { thinking?: { type: string }; reasoning_effort?: string };
expect(body.thinking).toEqual({ type: "enabled" });
expect(body.reasoning_effort).toBeUndefined();
```

## A2 — effort mapping order: HOLDS

`src/reasoning-effort.ts` `mapReasoningEffort()` consults
`reasoningEffortMapFor(provider, modelId)` before the supported-ladder clamp, so
`modelReasoningEffortMap` entries win directly: `high -> "enabled"`,
`low -> "disabled"`. `src/adapters/openai-chat.ts:561-570` then emits
`thinking: { type }` only for `enabled|disabled|adaptive`. The `020` design is
correct as written.

## A3 — `noVisionModels` semantics: CORRECTED (this one inverts the plan)

`020` treated `noVisionModels` as "this model is text-only". In this repository it
means the opposite at the catalog layer.
`src/codex/catalog/provider-fetch.ts:98-105`:

```ts
// Vision-sidecar coverage: `noVisionModels` marks models whose images the PROXY describes
if (modelInList(prov.noVisionModels, model.id)) {
  const base = inputModalities ?? model.inputModalities ?? ["text"];
  inputModalities = base.includes("image") ? [...base] : [...base, "image"];
}
```

Listing a model in `noVisionModels` makes the catalog **add** `image` so
attachments reach the proxy's vision sidecar. It is a routing claim about who
renders the image, not a capability denial.

That is a claim we have not verified for BigModel-hosted GLM text models, and
`zai` only lists its GLM-5.2 ids there for a documented reason. So the corrected
`020` entry **omits `noVisionModels` entirely** and declares modalities directly:

```ts
modelInputModalities: {
  "glm-4.6": ["text"],
  "glm-4.7": ["text"],
  "glm-4.7-flash": ["text"],
  "glm-5": ["text"],
  "glm-5.1": ["text"],
  "glm-4.6v": ["text", "image"],
},
```

This is what the Codex reviewer's B4 actually asked for, and it avoids asserting
sidecar coverage nobody tested. The `030` assertions change accordingly: assert
`modelInputModalities`, and assert `noVisionModels` is **undefined** rather than
asserting membership.

## A4 — the existing isolation test would not have caught this PR: CORRECTED SCOPE

`tests/provider-registry-parity.test.ts:796-812` guards directory/registry id
overlap, but only for rows where `supportLevel === "reference"`:

```ts
const directoryOnlyIds = FREE_PROVIDER_DIRECTORY
  .filter(entry => entry.supportLevel === "reference")
  .map(entry => entry.id);
```

`glm` is `supportLevel: "supported"` (`src/providers/free-directory.ts:106`), so
the original PR could add a `glm` registry entry pointing at a different host and
this suite would stay green. The reviewers caught it by reading; the tests could
not.

That makes the collision guard in `030` more than a test for our own entry. Add
to `wp4-tests`: a case asserting that **no** directory row — regardless of
`supportLevel` — shares an id with a registry entry whose `baseUrl` differs.
Reference rows keep their existing stricter rule (no overlap at all); connectable
rows get the endpoint-agreement rule, since an id may legitimately appear in both
lists when both point at the same place.

This is scope the goal objective anticipated ("verify no other directory/registry
row claims it") and it is the durable fix: the next contributor who reaches for a
taken id gets a failing test instead of a review comment.

## Verdict

VERDICT: PASS with two corrections (A1 test shape, A3 modality declaration) and
one scope addition (A4 generalized collision guard). No blocker to entering B.
