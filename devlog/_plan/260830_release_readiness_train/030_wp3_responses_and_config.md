# 030 — Responses authorization and proxy-policy visibility

WP3 has one clean observability merge and two repairs at trust boundaries. The order is fixed because
#2955 and #2953 both edit `src/server/responses/core.ts`, while #2947 is disjoint in config. Land #2955
unchanged, rebase and repair #2953 on it, then repair #2947. Anchors use `dev@47b8d1643` unless a
candidate head is stated explicitly.

The phase must preserve the core/Lab boundary. `src/server/responses/core.ts` is `PROTECTED` at
`tests/core-lab-boundary.test.ts:19-27`; its direct-import assertion at `:274-278` and transitive graph
assertion at `:280-288` remain gates after each Responses merge. No repair imports `src/lab`.

The repairs are already present at #2953 head `12a4d92fa` and #2947 head `be3d28706`. Pushing them
reset both exact-head author checklists, leaving both contributor PRs
DRAFT/BLOCKED/REVIEW_REQUIRED. A maintainer must not attest for either author. For each PR,
cherry-pick the contributor's commits plus the repair onto a maintainer-owned branch; Git preserves
the original author metadata. Open a maintainer PR that credits the contributor and explicitly names
the original PR it carries, then close that original as carried. #2952's clean merge without a head
push identifies the mechanism: the repair push, not the repaired behavior, invalidated readiness.

## #2955 — merge the empty-completion notice as-is

The default observer reports a completed turn with no text or tool call, but its warning interpolates
request-derived labels. PR head `0758f5e6` makes the record single-line without changing semantics.

In `src/server/responses/empty-completion-guard.ts`, keep `emptyCompletionNotice` at candidate
`:33-38`. It sanitizes only `providerName` and `modelId` and substitutes `unknown`; no request body or
tool arguments enter the message. `observeEmptyCompletion` stays at `:67-87`, with request-local
`sawContent` and `sawTerminal` allocated at `:71-72`.

In `src/server/responses/core.ts`, retain the import and callback at candidate `:5274-5276`. One
empty-turn callback emits one `console.warn`; do not log the serialized outbound body.

`tests/empty-completion-guard.test.ts` already has `the notice cannot be forged through the
caller-supplied provider or model label` and `the notice still names an ordinary route and degrades
to a stated placeholder`, pinning one record plus ordinary and `unknown/unknown` labels. No follow-up diff.

## #2953 — restore the selected MCP identity, not bare exec authority

PR head `5bd042ab` correctly closes the privilege widening. `CODE_MODE_EXEC_TOOL_NAME` at
`src/types/tools.ts:53` names the switch in `normalizeDeclaredToolName` at `:55-70`, and `src/types.ts`
re-exports it. `addWireToolName` at candidate `src/server/responses-undeclared-tool-guard.ts:77-100`
adds the flattened identity at `:95` but withholds bare `exec` at `:96-99`; keep this unchanged.

Candidate `src/server/responses/core.ts:3680-3692` must also stay: it copies bridge-created bare
`exec` into `declaredWireToolNames` only for a real top-level declaration. This keeps `apply_patch`,
`exec_command`, and `shell_command` unauthorized. Case, Unicode, separator, and nested-namespace
probes found no bypass, so add no fuzzy matching or canonicalization.

That line also exposes the legitimate failure. Base `buildToolBridgeMaps` creates a bare alias only
when bare `tool_choice` selects exactly one namespaced tool
(`src/server/responses/collaboration.ts:142-164`). A sole MCP `exec` may therefore return as bare
`exec`, but reaches `undeclaredNameInItem` (`src/server/responses-undeclared-tool-guard.ts:259-288`)
without its namespace and becomes a 502.

The repair at `12a4d92fa` derives a request-bounded bare-selector alias map from
`toolBridgeMaps.toolNsMap` (built at base `src/server/responses/collaboration.ts:105-165`). Admit only
entries whose key equals the value's bare `name` and whose value has a namespace. Convert them to
`RoutedNamespaceToolAliases` using `freeform ? "custom" : "function"`. If an adapter alias at
candidate core `:3519-3522` claims that key for another identity, leave it unrestored and fail closed.

The repair merges the alias into `routedNamespaceToolAliases`. Existing SSE and JSON restoration at
candidate core `:4460-4463` and `:4689-4692` then produces
`{ name: "exec", namespace: "mcp__functions" }` before guards at `:4499-4507` and
`:4717-4736`. It also uses existing `restoreRoutedNamespaceCalls` before the inspection and cache
guards at `:3711-3747`. This restores request authority without expanding it and adds no module.

In `tests/responses-undeclared-tool-guard.test.ts`, the repaired head keeps the candidate collector
and replay cases and adds the end-to-end case `a bare tool_choice selecting a namespaced exec
restores an upstream bare exec` beside candidate `:1379`. It uses the existing `post` seam, whose
`toolChoice` parameter is at candidate `:741-775`; the case declares only `mcp__functions.exec`,
selects bare `exec`, returns an upstream `custom_tool_call` named `exec`, and asserts HTTP 200 plus
the restored `name` and `namespace`.

The adjacent case is strengthened under the exact name `a bare tool_choice selecting a namespaced
exec still rejects shell helper aliases`. It drives `apply_patch`, `exec_command`, and
`shell_command` as three sequential upstream responses. Each returns 502 and names that exact
undeclared tool in the error. Positive restoration and negative normalization authority remain
separate assertions.

## #2947 — keep startup graceful but make discarded policy visible

PR head `032e1d1e` prevents malformed passthrough config from throwing, but its fallback is silent.
At candidate `src/config.ts:3143-3144`, an explicitly configured non-string proxy becomes no proxy;
unless an operator environment variable wins, outbound traffic is direct. At `:3152-3158`, a
wrong-typed `noProxy` value or array member is dropped, changing which destinations bypass the
proxy. Both are network-policy changes, not harmless parse cleanup.

The repair at `be3d28706` keeps the type guards in `applyProxyEnv` at candidate
`src/config.ts:3136-3167`, then adds a
module-level once-per-process memo beside `warnedConfigFallbacks` at base `src/config.ts:419-420`.
Key it by the field class (`proxy` or `noProxy`), not by the rejected value, and do not clear it in
`reconcileConfigWarningMemos` at base `:423-429`; config generations must not turn one malformed
setting into repeated process-log noise.

The repair adds a small warning helper that accepts only the field class. The proxy message says
that the configured proxy was ignored and outbound traffic may use existing proxy environment
variables or go direct. The noProxy message says that invalid exclusions were ignored while valid
entries and loopback exclusions remain. It never passes, stringifies, interpolates, sanitizes,
hashes, or counts the raw value: proxy URLs can contain credentials, and noProxy values can disclose
internal hosts.

The repaired head calls the helper before returning for a present non-string `config.proxy`, and
when either a whole non-string `config.noProxy` or one or more non-string array entries are filtered.
It preserves graceful startup, the usable array entries, environment-variable precedence, and
unconditional loopback entries exactly as PR #2947 already does.

In `tests/proxy-env.test.ts`, the repaired head imports `spyOn` and adds the cases `warns once when
an invalid proxy is discarded without exposing its raw value` and `warns once when invalid noProxy
values are discarded without exposing their raw values` before the candidate malformed-value cases
at `:33-55`. Each case calls `applyProxyEnv` twice, asserts one warning for its field class,
preserves the existing environment assertions, and asserts the joined mock calls contain neither a
credential marker nor an internal-host marker from the rejected object/array. Each restores the
console spy in `finally`.

## Focused verification

Run only the covering files, after the corresponding repaired PR is rebased on the prior merge:

```bash
bun test tests/empty-completion-guard.test.ts tests/core-lab-boundary.test.ts
bun test tests/responses-undeclared-tool-guard.test.ts tests/core-lab-boundary.test.ts
bun test tests/proxy-env.test.ts
```

The local full suite is forbidden for this train. WP3 is complete only when all three focused
commands exit zero, the two Responses PRs retain the direct and transitive Lab-boundary cases, the
bare-selector positive case returns 200, every helper alias returns 502, and discarded proxy policy
produces one privacy-safe warning per field class without changing startup into a hard failure. Land
#2953 and #2947 through their maintainer-owned carry PRs, and close the blocked originals as carried.
