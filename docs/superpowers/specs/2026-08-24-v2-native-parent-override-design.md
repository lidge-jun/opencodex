# V2 Native Parent Override Design

## Summary

Add an experimental, default-off dashboard setting that replaces a ChatGPT-native
V2 root parent with one configured routed model before the parent executes. The
routed parent then creates plaintext V2 agent tasks, so routed children can read
them without a native ChatGPT recovery request or ChatGPT quota use.

This is intentionally separate from the existing safeguards:

- `keepNativeChatGptOnV1` preserves the native parent but moves it to the V1 agent
  surface.
- `agentTaskRecovery` preserves the native V2 parent and asks ChatGPT to recover an
  already-encrypted child task. It consumes an additional native request.
- `v2NativeParentOverride` keeps the V2 surface but replaces the native root parent
  with a routed provider before any child task can be encrypted.

## Problem

Codex's native ChatGPT V2 parent creates backend-encrypted `agent_message` task
payloads. A routed child such as Gemini, Claude, Grok, or Kimi cannot decrypt that
payload and OpenCodex returns `unreadable_encrypted_agent_task`.

The failure occurs before the selected child can do useful work. Recovering the
task after creation still requires ChatGPT quota and adds a second model call.
Running the root parent through a routed provider prevents the ciphertext from
being created in the first place.

## Goals

- Keep the Codex V2 `spawn_agent`, `send_message`, `followup_task`,
  `interrupt_agent`, and `list_agents` surface.
- Replace only ChatGPT-native V2 root turns with one operator-selected routed
  model.
- Preserve every child model choice, including native children.
- Preserve shadow/helper routing and combo behavior.
- Route root compaction through the same configured routed model and the existing
  synthetic compaction implementation.
- Never silently fall back to ChatGPT after an eligible override has been selected.
- Keep the feature default-off and visibly experimental in the dashboard.

## Non-goals

- Decrypt ChatGPT ciphertext locally.
- Change Codex's encrypted V2 protocol.
- Automatically rank or select a parent model.
- Rewrite child turns or nested native child parents.
- Add per-thread target pinning or a new persistence store.
- Add a CLI command; configuration and the existing `/api/v2` dashboard surface
  are sufficient for this experiment.
- Replace or remove `keepNativeChatGptOnV1` or `agentTaskRecovery`.

## Approaches considered

### 1. Expose `agentTaskRecovery.enabled`

This is the smallest UI-only change, but it is not the requested behavior. It
uses an authenticated ChatGPT recovery request after encryption, consuming native
quota and adding latency. Keep it as an independent recovery feature.

### 2. Rewrite Codex's configured default model

This avoids proxy interception, but it changes the user's model selection outside
the request boundary, is difficult to scope to V2, and cannot reliably preserve an
explicit model selected in the app. Reject.

### 3. Guarded request-time override

Resolve the requested route normally, prove that the request is an eligible native
V2 root, then reroute to the configured target. This reuses the existing routing,
provider validation, child markers, and routed compaction behavior. Choose this
approach.

## Persisted configuration

Add one optional object near the existing multi-agent settings:

```ts
v2NativeParentOverride?: {
  enabled?: boolean;
  model?: string;
};
```

Semantics:

- Missing object or `enabled !== true`: disabled.
- A present `model` must be nonblank. Management writes require a routed model
  whenever `enabled === true`; the runtime rejects an enabled subtree whose target
  later becomes missing or unroutable.
- A malformed hand edit disables only this optional subtree; it must not invalidate
  providers, accounts, or the rest of the config.
- The selected model remains stored while disabled so the switch can be toggled
  without losing the choice.
- Provider-id migration and provider rename operations rewrite `model` like
  `shadowCallIntercept.model` and `injectionModel`.

There is no default target. Choosing Kimi K3, Gemini, Claude, or another provider
is an operator decision based on availability, context window, cost, and trust.

## Eligibility and request flow

### Ordinary Responses turns

Keep the existing order through parsing and shadow interception. After the first
normal route resolution and before child fallback/authentication:

1. Require `v2NativeParentOverride.enabled === true`.
2. Require `collabSurface(parsed) === "v2"`, or a parsed
   `_compactionRequest === true` while `multiAgentMode === "v2"`.
3. Reject spawned children using the existing exact `isThreadSpawnRequest`
   classifier.
4. Reject any other request carrying `x-openai-subagent`; reviews, memory,
   compaction helpers, and other maintenance turns remain on their existing paths.
5. Exclude combo attempts. Combo target semantics must not change.
6. Require the already-resolved source provider to satisfy
   `isCanonicalOpenAiForwardProvider`. Model-name heuristics are not sufficient
   because aliases, account selectors, policies, and default providers can change
   the physical route.
7. Require a nonblank configured target and resolve it through the normal router.
8. Require the resolved target provider to be noncanonical.
9. Only after target resolution succeeds, rewrite both `parsed.modelId` and
   `parsed._rawBody.model`, replace the route, and continue normally.

The original request model remains in `logCtx.requestedModel`; the effective routed
model/provider use the existing resolved fields. No new request-log field is needed.

### `/responses/compact`

The separate compact handler resolves the original model before selecting native
or synthetic compaction. Apply the same source/target identity checks there when:

- the feature is enabled,
- `multiAgentMode === "v2"`, and
- the request is not a spawned child or another `x-openai-subagent` helper.

Codex forwards child-session compatibility metadata into compact requests, so a
native child's compaction still carries the child marker and remains native.
Eligible root compaction replaces the route before the native-compact branch, which
naturally selects the existing routed synthetic compaction path.

Requiring explicit `multiAgentMode === "v2"` for the compact endpoint is a deliberate
guard. Compact requests do not carry an independent V1/V2 surface field. The
dashboard therefore enables this experiment only when V2 is explicitly forced;
the `default` surface is not sufficient even when a particular native model happens
to be upstream-pinned to V2.

## Failure behavior

Once an eligible native V2 root is identified, the override is fail-closed:

- missing/unroutable target: return a routing/configuration error;
- target resolves back to canonical ChatGPT: return a validation error;
- disabled target provider: return the existing no-route error;
- provider request fails: return the routed provider failure through the normal
  adapter path.

None of these cases may send the eligible request to ChatGPT. Requests outside the
eligibility rules remain unchanged.

## Management API

Extend the existing `GET, PUT /api/v2` route with one object:

```json
{
  "v2NativeParentOverride": {
    "enabled": false,
    "model": null,
    "active": false
  }
}
```

`active` is derived and read-only. It is true only when the feature is enabled,
the target is present, native parents are not being kept on V1, the effective mode
is explicitly `v2`, and the upstream V2 flag is enabled.

PUT accepts a complete object with `enabled: boolean` and `model: string | null`.
Validate the entire object before any write. A nonnull model must resolve to a
noncanonical configured route. Enabling without an eligible model, while V2 is not
explicitly active, or while `keepNativeChatGptOnV1` is active returns 400 and leaves
configuration unchanged.

The write persists only this subtree and reuses the existing `/api/v2` refresh/read
flow. It does not restamp the catalog because request-time routing, not catalog
metadata, changes.

## Dashboard

Add one experimental row under Subagents → Settings, near the V2/Ultra controls:

- routed-parent model select, populated from the already-loaded delegation model
  catalog and excluding canonical ChatGPT rows;
- accessible switch with `aria-pressed`;
- short explanation that the app may still display the selected native model while
  OpenCodex executes the root on the routed target;
- warning that prompts, repository context, and tool results are sent to the chosen
  provider and that model behavior/context limits may differ;
- inactive guidance when V2 is not explicitly forced or “Keep ChatGPT on V1” is on.

Changing the select while disabled stores the next target. Enabling performs one
atomic PUT with both fields. After every PUT, re-read `/api/v2`; do not trust the
optimistic patch.

All visible strings use the existing i18n system and are added to every locale.
No new dependency or bespoke model picker is introduced.

## Security and privacy

- The feature broadens which provider receives root-agent prompts, repository
  context, tool results, and conversation history. The UI must state this clearly.
- The management endpoint uses the existing authenticated/CSRF-protected dashboard
  boundary.
- Request bodies, prompts, account identifiers, and credentials must not be added to
  logs.
- Error messages may name only configured model/provider ids already safe for the
  existing routing surfaces.
- Runtime classification uses trusted protocol structure and resolved provider
  identity, not caller-controlled model-name prefixes.

## Testing

Use TDD for every behavior change.

### Config and migration

- valid object round-trips;
- malformed hand edits disable only the subtree;
- write-time invalid shapes are rejected;
- provider-id rename rewrites the selected target.

### Management API

- GET reports disabled defaults and derived active state;
- PUT stores enabled/disabled state and preserves a selected target;
- invalid shapes, native targets, missing targets, non-V2 mode, and keep-native-V1
  conflicts return 400 without partial writes;
- recovery-only and unrelated V2 settings remain unchanged.

### Runtime

- native V2 root reaches the configured routed provider and never ChatGPT;
- routed roots are unchanged;
- V1/native roots are unchanged;
- child markers preserve the child's selected model;
- helper markers preserve shadow/helper behavior;
- combo attempts are unchanged;
- invalid or now-unavailable targets fail before any native upstream fetch;
- eligible root compact uses routed synthetic compaction;
- native child compact remains native.

### Dashboard

- state loads from `/api/v2`;
- controls are inactive outside explicit V2;
- selection and switch send the complete object;
- the post-save re-read wins over stale state;
- API failures surface through the existing notice.

### Final validation

- focused runtime, API, config, and GUI tests;
- root `bun run typecheck` and `bun run test` because shared routing/config/server
  behavior changes;
- `bun run privacy:scan` because request routing/logging behavior changes;
- GUI `bun run lint:i18n`, `bun run lint`, and `bun run build`;
- docs-site build.

## Trade-offs and limitations

- The Codex UI still names the originally selected native model; usage logs show the
  requested and resolved models separately.
- The routed parent may have different instruction following, tool calling, context,
  latency, and cost characteristics from the selected native model.
- There is no automatic fallback to ChatGPT. Availability is lower when the selected
  routed provider is down, by design.
- The target is read per request. Changing it mid-session changes subsequent parent
  turns and compaction; no per-thread pin is added.
- Native children are preserved. If a native child later spawns a routed grandchild,
  that nested native parent can still create an unreadable encrypted task. Extending
  the override to nested parents is a separate experiment.
- Explicit V2 mode is required. Base/default mode is intentionally unsupported so
  compact routing remains deterministic without per-thread state.
