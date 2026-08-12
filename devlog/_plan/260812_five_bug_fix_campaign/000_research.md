# 000 — Research: five confirmed bug issues, live code grounding

Unit: `260812_five_bug_fix_campaign`
Baseline: `origin/dev` at `cbbfdd877` (`fix(release): filter successful gate runs from JSON`).
Date: 2026-08-12.

## Why this unit exists

A triage pass over the 16 open `bug`-labelled issues found that **no merged PR
currently closes any of them**: the only merged PR carrying a closing reference
in the recent window is #1501 → #1477, and #1477 is already closed. Two issues
have draft PRs in flight (#1503 → draft #1508, #1497 → stale draft #1008) and
the rest have no implementation at all.

Five issues were selected because each has a **code-level defect already located
in the current tree**, not a missing-evidence or upstream-attribution problem:

| Issue | Area | Located in current tree |
|---|---|---|
| #1514 | `openai-chat` adapter | `src/adapters/openai-chat.ts:900-907` |
| #1503 | `google` adapter | `src/adapters/google.ts:615-618`, `:836` |
| #1497 | management usage API | `src/server/management/logs-usage-routes.ts:210-214` |
| #1409 | provider config write | `src/server/management/provider-routes.ts:353-363` |
| #1419 | service lifecycle | `src/lib/abort.ts:125-133` neighbourhood |

Explicitly out of scope for this unit: #1527, #1524, #1388, #1302, #1296,
#1059, #1049, #1024, #904, #417, #92. Those are either needs-info, upstream
tracking, policy-level enhancements, or CI burn-down work.

## Per-defect grounding

### #1514 — `flushToolCalls` can emit a tool call with an empty name

`parseStream` accumulates streamed tool calls into `PendingToolCall` records
whose `name` starts as the empty string:

```ts
call = { key: key ?? `seq:${pendingToolCalls.length}`, id: "", name: "", args: "", argsBytes: 0 };
```

`name` is only ever populated from a truthy upstream field:

```ts
if (tc.function?.name && !call.name) call.name = tc.function.name;
```

So an upstream that streams `function.arguments` deltas while never sending
`function.name` leaves `call.name === ""`. At every flush boundary the call is
emitted regardless:

```ts
const flushToolCalls = function* (): Generator<AdapterEvent> {
  for (const call of closeToolCalls()) {
    if (!call.id) call.id = `call_${++toolCallSeq}`;
    yield { type: "tool_call_start", id: call.id, name: call.name };   // name may be ""
    if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
    yield { type: "tool_call_end" };
  }
};
```

Note the asymmetry that makes this a real bug rather than a style complaint:
the **id** is already defended (`if (!call.id)` synthesizes one) while the
**name** — the field that actually decides which tool runs — is not. A
synthesized id is harmless because the id is an opaque correlation handle; a
synthesized name would be a guess at intent, so the correct treatment is
fail-closed, not invention.

There are three flush sites, and the fix has to hold at all three:

1. `[DONE]` frame (`:925`) — the OpenCode Zen / DeepSeek path in the report.
2. `finish_reason` on a choice (`:1028`).
3. Post-loop normal completion (`:1085`).

Existing invariants that must survive (from #1325 and the truncation work):

- a non-array `delta.tool_calls` is terminal protocol corruption, not padding;
- a raw EOF with pending tool calls and no terminal signal is a truncation
  error and must stay fail-closed;
- a claimed tool call must not be silently dropped when doing so could orphan a
  matching `function_call_output` on the next turn.

External contract check (Luna lane, Gemini lane returned; OpenAI lane pending):
the OpenAI streaming convention is that the **first** chunk of a tool call
carries `id` and `function.name`, with subsequent chunks carrying only
`function.arguments` deltas. An upstream that never sends the name is therefore
non-conforming, which is exactly why provider-specific tolerance is the wrong
fix and fail-closed rejection is the right one.

### #1503 — Google `thought: true` parts are emitted as visible text

Streaming parser:

```ts
for (const part of parts) {
  if (part.text) {
    emittedContentEvent = true;
    yield { type: "text_delta", text: part.text };
  }
```

Buffered parser:

```ts
for (const part of candidates[0].content.parts) {
  if (part.text) events.push({ type: "text_delta", text: part.text });
```

Neither branch reads `part.thought`. The part type declared locally is
`{ text?: string; functionCall?: {...} }`, so the flag is not even in the
narrowed shape, while `observeAntigravityReplay` already receives the raw
`parts as unknown[]` and does look at signature fields.

Primary-source confirmation (Luna lane 2, returned 2026-08-12):

- `Part.thought` is documented as "whether the part represents the model's
  thought process or reasoning" in the Gemini REST reference and the
  `@google/genai` `Part` interface. A text-bearing part with `thought: true` is
  a **thought summary**, not the answer channel.
- `thoughtSignature` is an opaque encrypted reasoning handle that must be
  replayed byte-for-byte in its original part; for Gemini 3 function calling the
  first function-call part of each step must carry it or the API returns 400.
- Official SDK examples branch on `part.thought` to render thoughts in a
  separate "Thought" channel; proxies (OpenRouter, LiteLLM) normalize the same
  distinction into a reasoning field rather than merging it into content.

So the required behavior — thought text becomes hidden reasoning, ordinary text
stays visible, signatures untouched — is the vendor-documented contract, not a
local preference.

**Contributor work exists.** Draft PR #1508 by `Ingwannu`
(`agent/fix-1503-google-thought-visibility`, head `219e7f365a`, `MERGEABLE`)
already implements this across `src/adapters/google.ts`,
`tests/google-hardening.test.ts`, and `structure/04_transports-and-sidecars.md`.
The correct action is to review and land that branch, not to reimplement it.

### #1497 — usage `30d` and `all` share one moving byte tail

`GET /api/usage` reads first and filters second:

```ts
const effectiveReadLimit = config.managementUsageMaxReadBytes ?? 64 * 1024 * 1024;
...
const snapshot = await readUsageSnapshotForManagement(effectiveReadLimit);
const summary = {
  ...summarizeUsage(snapshot.entries, range, now, surface),
  historyTruncated: snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated,
```

`readUsageSnapshotForManagement` delegates to
`readUsageEntriesFullCooperatively(path, signal, maxReadBytes)`, which reads the
**newest `maxReadBytes`** of `usage.jsonl`. The range filter inside
`summarizeUsage` then operates on whatever survived that byte cut. On the
reporter's installation the newest 64 MiB covered roughly 39 hours, so `30d`
omitted 73.6% of requests and `range=all` returned the same rows under the label
"Available history".

The response is not silent about it — `historyTruncated: true` and
`truncatedPrefixBytes` are both returned — but the dashboard labels remain `30d`
and `Available history`, and cumulative totals can *decrease* as old rows fall
out of the moving window.

Draft PR #1008 proposes a daily rollup sidecar plus raw-tail merge. It is stale,
conflicting, and carries unresolved correctness findings (crash-safe
append/commit validation, truncated-ledger invalidation, partial-day overlap,
request dedup, disabled-rollup behavior). An incorrect derived aggregate is
worse than an honestly truncated one, so this unit does not adopt it.

### #1409 — user `modelContextWindows` overrides are replaced by registry seeds

Two write paths exist and they disagree.

**PATCH** (`applyProviderPatch`, `:187-208`) merges per key and preserves
unmentioned entries:

```ts
const windows: Record<string, number> = { ...(next.modelContextWindows ?? {}) };
```

**POST overwrite** (`:353-364`) does not:

```ts
enrichProviderFromCatalog(name, prov);
...
const existingPool = config.providers[name]?.apiKeyPool;
if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
const existingCosts = config.providers[name]?.modelCosts;
if (existingCosts && !prov.modelCosts) prov.modelCosts = existingCosts;
config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
```

The dashboard's add/edit form does not send `modelContextWindows`. So on an
overwrite `prov.modelContextWindows` is absent,
`enrichProviderFromCatalog` → `enrichProviderFromRegistry` fills it from the
registry seed:

```ts
if (!prov.modelContextWindows && seed.modelContextWindows) prov.modelContextWindows = { ...seed.modelContextWindows };
```

and the stored row becomes the registry default. For `opencode-go` the seed is
exactly `{ "kimi-k3": KIMI_K3_STANDARD_CONTEXT_WINDOW }` — which is precisely the
`{"kimi-k3": 262144}` the reporter observed replacing their
`{"deepseek-v4-flash": 900000}`.

Note the shape of the existing defenses: `apiKeyPool` and `modelCosts` are
carried over with exactly this rationale ("the add/edit form does not send
modelCosts, so an overwrite must not silently erase hand-edited per-model
prices"). `modelContextWindows` is the same class of hand-edited user data and
was simply not included. The reporter's timeline — value lost across an upgrade,
becoming visible after "a later full config write after an unrelated provider
change" — matches an overwrite through this path rather than a defect in
`derive.ts` or `router.ts` merging.

`enrichProviderFromRegistry` itself is fill-only and correct; the bug is that
the POST path treats "the client omitted the field" as "the user has no value",
for a field the client never sends.

### #1419 — a TLS/reset failure kills the whole Bun process

Reported signature: `EXC_BREAKPOINT / SIGTRAP` on the main thread ~0.5-0.6s after
a connection reset followed by `unknown certificate verification error`, twice,
with matching Bun image UUID and stack offsets. Because `ocx gui` serves the
dashboard from the same process, the dashboard dies with the proxy.

The repository already knows this failure family. `src/lib/abort.ts` documents
an uncatchable native rejection:

> Bun's HTTP client, when a `fetch(..., { signal })` is aborted AFTER the
> response resolved, tears down the response body stream and rejects any
> in-flight internal read. ... Bun reports it as
> `unhandledRejection: TypeError: null is not an object` (native-only stack) —
> uncatchable by any caller try/catch.

`cancelBodyOnAbort` exists to absorb that specific orphaned rejection by making
us the consumer that settles the body. `src/lib/eventstream-decoder.ts:211`
carries the same note.

External check (Luna lane 3, returned 2026-08-12): there is **no** known
`oven-sh/bun` issue establishing that TLS verification failure or a socket reset
aborts with `SIGTRAP`/`EXC_BREAKPOINT`, and the current stable Bun is `1.3.14`
(2026-05-13) — i.e. there is no newer stable release to upgrade into as a fix.
Related but distinct: #31894 (stale pooled socket, 1.3.14) and #31463
(`ECONNRESET` after `Connection: close`). Conclusion: this cannot be closed by a
runtime bump, and attributing the trap requires the full faulting frame list the
maintainer already asked for.

That bounds what this unit can honestly deliver for #1419: **process survival
hardening on the paths we own**, plus a documented disposition, rather than a
claimed fix for a native trap we cannot reproduce. See `050`.

## Verification environment

All test and typecheck evidence for this unit is produced on `ssh lidge`
(Linux x86_64, 16 cores, 30 GB RAM, `bun` at `~/.bun/bin/bun`), per the
standing rule that CPU-heavy suites do not run on the local workstation. The
remote checkout at `~/Developer/opencodex` is stale and dirty, so a dedicated
clean worktree is provisioned rather than reusing it.
