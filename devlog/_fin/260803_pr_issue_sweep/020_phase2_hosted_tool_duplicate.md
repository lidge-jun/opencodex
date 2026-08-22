# 020 — Phase 2: hosted image tool preferences (#837 lands, #616 closes)

## The provenance finding

These were filed as two pull requests solving the same problem. They are one
implementation submitted twice.

| | #616 | #837 |
|---|---|---|
| Opened | 2026-07-28T12:13:33Z | 2026-08-01T04:59:16Z |
| Substantive commit | `1aba0e4b` | `89d51dbc` |
| Author | Eleven-is-cool | Eleven-is-cool |
| Authored at | 2026-07-28T12:23:13Z | 2026-07-28T12:23:13Z |
| Committer | Eleven-is-cool | Ingwannu |
| Diff | +819/−18, 16 files | identical |

#837 replayed #616's commit onto a newer base, preserving authorship, and adds
one independent change:

```diff
- { type: "function", name: "exec_command", parameters: {} },
+ { type: "function", name: "exec_command", parameters: { type: "object" } },
```

That is a fixture correction for schema normalization present only on the newer
base. #837's body already credits #616.

So the closure reason for #616 is supersession by an integration that carries
the same authorship, not duplication and not "we fixed it elsewhere."

## What the change does

`hosted-tool-policy.ts` does not exist on `dev`. The policy currently lives as
an adapter-local constant at `src/adapters/openai-responses.ts:164-174`:

```ts
const UNSUPPORTED_HOSTED_TOOLS = [
  {
    match: model => model.includes("codex-spark"),
    tools: new Set(["image_generation", "tool_search"]),
  },
];
```

Both PRs extract it unchanged into a nine-line module so config validation can
also consult it, then add an exact-model opt-in
`modelPreferHostedTools?: Record<string, string[]>` that runs *before* ordinary
normalization:

```ts
} else {
  outBody = preferConfiguredHostedTools(
    outBody,
    provider,
    parsed.modelId,
    parsed._openAiVirtualSelectedModelId,
  );
  outBody = normalizeImageGenClientTools(outBody);
}
```

The defect being fixed: `normalizeImageGenClientTools()` gives a client
`image_gen` declaration precedence over hosted `image_generation`, preserving
even an empty client namespace. Gateways that reserve `image_gen` server-side
reject that empty namespace, and the user loses hosted image generation with no
way to express the preference.

`src/server/auth-cors.ts` is in the file set because
`providerManagementConfigError()` happens to live there; the hunk wires the new
validator into `/api/providers` writes. No origin, header, cookie, or token
behavior changes.

## Two defects both copies share

Both must be fixed before landing. Both were reproduced directly.

**Validation disagrees with runtime routing** — `src/config.ts:641`.
Configuring `modelPreferHostedTools` for `deepseek/deepseek-v4-flash` is
rejected with `requires the openai-responses wire`, but at runtime
`resolveWireProtocolOverride(..., "responses")` selects `openai-responses` from
registry `modelWireDefaults`. The validator starts from `registry.adapter` and
never consults the inbound-aware `providerModelWireDefault()` path. A valid
preference is refused at config load and through management writes.

Fix: compute the effective wire through the same Responses-inbound
registry/default/override sequence the runtime uses.

**Inherited model IDs throw before dispatch** —
`src/adapters/openai-responses.ts:641-643`.

```ts
provider.modelPreferHostedTools?.[modelId]
```

reads `Object.prototype`, so a routed model ID of `constructor` or `toString`
yields a function and the subsequent `.includes` throws
`TypeError: ...?.includes is not a function`, failing the request before
upstream dispatch.

Fix: own-property lookup plus `Array.isArray(preferredTools)` before `includes`.

## Rebase surface

Neither head applies cleanly to `fa51fce541`. Both conflict in exactly six
files:

1. `docs-site/src/content/docs/reference/configuration.md`
2. `docs-site/src/content/docs/ja/reference/configuration.md`
3. `docs-site/src/content/docs/ko/reference/configuration.md`
4. `docs-site/src/content/docs/ru/reference/configuration.md`
5. `docs-site/src/content/docs/zh-cn/reference/configuration.md`
6. `src/config.ts`

The adapter, policy module, virtual-model, types, CORS, structure doc, and all
four test files auto-merge.

## Plan

1. Rebase #837's head onto `origin/dev`, resolving the five locale docs and
   `src/config.ts` by hand. Preserve `Eleven-is-cool` authorship on `89d51dbc`
   through the rebase.
2. Fix the wire-resolution defect in `src/config.ts`; add a DeepSeek regression
   to `tests/config.test.ts` and the management-boundary equivalent.
3. Fix the prototype-chain lookup in `src/adapters/openai-responses.ts`; add a
   `constructor`/`toString` regression to
   `tests/openai-responses-passthrough.test.ts`.
4. Ablate both new tests against the unfixed code.
5. Land #837; close #616 with the supersession reason and thanks to
   Eleven-is-cool for the original implementation.

## Accept criteria

- Both new regressions fail with their fix reverted.
- `bun x tsc --noEmit` exit 0; focused suites green.
- `gh pr view 837 --json state` MERGED, `gh pr view 616 --json state` CLOSED
  with a comment naming #837 and preserving credit.
