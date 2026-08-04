# 030 — WP3: expose the WP2 keys through the management API and CLI

One full PABCD cycle. Depends on WP2 (`020`): the readers and writers must exist first.

## Scope

`GET`/`PUT /api/v2` currently carries `enabled`, `maxConcurrentThreadsPerSession`, and
`multiAgentMode`, plus `agentsMaxThreadsConflict` on read. This phase adds the three
WP2 keys to that route and reports them in `ocx v2 status`.

## Change map

| Path | Action |
|---|---|
| `src/server/management/agent-settings-routes.ts` | MODIFY — extend `GET`/`PUT /api/v2` |
| `src/cli/v2.ts` | MODIFY — report the new values in status |
| `src/cli/help.ts` | MODIFY — document new subcommands if added |
| the route test file | MODIFY — request/response coverage |

Test files verified to exist: `tests/codex-v2-gate.test.ts` already covers the
`/api/v2` surface and is the primary target; `tests/cli-headless-parity.test.ts` also
references it and may need updating if the CLI status output changes.

## Diff 1 — `GET /api/v2` response

MODIFY `src/server/management/agent-settings-routes.ts:106`.

The current response shape is:

```
{ enabled, agentsMaxThreadsConflict, maxConcurrentThreadsPerSession, multiAgentMode }
```

AFTER, additively:

```
{
  enabled,
  agentsMaxThreadsConflict,
  maxConcurrentThreadsPerSession,
  multiAgentMode,
  agentsEnabled,                  // boolean | null  (null = unset, upstream default true)
  agentsMaxDepth,                 // number  | null  (V1 only; ignored by V2 upstream)
  subagentDeveloperInstructions,  // string  | null  (null = inherit, "" = clear)
  agentsMaxDepthAppliesToActiveBackend  // boolean: false whenever V2 is active
}
```

The last field exists so the GUI cannot accidentally present `max_depth` as an
effective V2 limit. Upstream ignores it under V2; a client that shows it as active
would be lying to the user. Deriving it server-side keeps that rule in one place.

Read the three new values with the WP2 readers. Do not re-implement TOML parsing here.

## Diff 2 — `PUT /api/v2` request

MODIFY `src/server/management/agent-settings-routes.ts:116`.

BEFORE:

```ts
let body: { enabled?: unknown; maxConcurrentThreadsPerSession?: unknown; multiAgentMode?: unknown };
try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
const wantsFlag = body.enabled !== undefined;
const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
const wantsMode = body.multiAgentMode !== undefined;
```

AFTER:

```ts
let body: {
  enabled?: unknown;
  maxConcurrentThreadsPerSession?: unknown;
  multiAgentMode?: unknown;
  agentsEnabled?: unknown;
  agentsMaxDepth?: unknown;
  subagentDeveloperInstructions?: unknown;
};
try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
const wantsFlag = body.enabled !== undefined;
const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
const wantsMode = body.multiAgentMode !== undefined;
const wantsAgentsEnabled = body.agentsEnabled !== undefined;
const wantsMaxDepth = body.agentsMaxDepth !== undefined;
const wantsSubagentInstructions = body.subagentDeveloperInstructions !== undefined;
```

Validation rules, each returning `400` with a specific message:

| Field | Accepted | Rejected |
|---|---|---|
| `agentsEnabled` | `boolean`, or `null` to unset | anything else |
| `agentsMaxDepth` | integer, or `null` to unset | non-integer, non-null |
| `subagentDeveloperInstructions` | `string` including `""`, or `null` to unset | non-string, non-null |

The `""` versus `null` distinction must survive the route boundary. JSON gives us both,
so the only risk is a falsy check collapsing them; use explicit `=== null` and
`typeof === "string"` tests.

Extend the existing "at least one field required" guard to count the three new flags,
otherwise a body containing only `agentsEnabled` is rejected as empty.

## Diff 3 — the `agents.enabled` + V2 interaction warning

The existing route already rejects a mode/flag conflict. Add a non-fatal warning, not a
rejection, for this combination:

- `agentsEnabled: false` while `features.multi_agent_v2` is enabled

Upstream resolves this in V2's favor: an enabled feature flag overrides
`[agents].enabled = false` entirely. So the write should succeed and the response
should carry a warning explaining that V2 remains active despite the off switch.
Rejecting would be wrong; silently accepting would leave the user thinking they turned
multi-agent off.

Warning text, appended to the existing `warnings: string[]`:

```
agents.enabled = false has no effect while features.multi_agent_v2 is enabled; upstream keeps V2 active.
```

## Diff 4 — CLI status

MODIFY `src/cli/v2.ts:76` (`cmdV2`). Status currently reports the flag, multi-agent
mode, and thread limit (lines 87-96). Add the three values, with `max_depth` explicitly
labeled as V1-only when V2 is active, so the CLI carries the same honesty the API does.

If `ocx v2` gains write subcommands for these keys, update the `v2` entry in
`src/cli/help.ts:225`. If the GUI is the only writer, leave the CLI read-only and say
so in the phase's D summary.

## Accept criteria

1. `GET /api/v2` returns all four new fields with correct tri-state values.
2. `PUT /api/v2` writes each new field independently and rejects wrong types with a
   field-specific 400.
3. `subagentDeveloperInstructions: ""` writes an empty string; `null` removes the key.
4. `agentsEnabled: false` with V2 enabled returns 200 plus the warning above.
5. `agentsMaxDepthAppliesToActiveBackend` is `false` whenever V2 is active.
6. A body containing only a new field is accepted, not rejected as empty.
7. `ocx v2 status` shows the new values and marks `max_depth` V1-only under V2.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| warning branch | `agentsEnabled: false` + V2 on | response `warnings` contains the exact string; status still 200 |
| tri-state read | config with key absent | field is `null`, not `false` or `0` |
| empty-string write | `""` payload | config gains the key with an empty value; re-read returns `""` |
| unset write | `null` payload | key removed; re-read returns `null` |
| depth-inapplicable flag | V2 enabled | flag `false`; with V2 disabled, `true` |
| empty-body guard | `{}` | 400, unchanged from today |

The warning branch is the one worth watching: it is easy to implement as a rejection by
reflex, which would contradict upstream precedence.

## Verification gate

`bun run typecheck`, the route test file, and the CLI test file all green, with the
seven criteria asserted and each activation scenario driven.

---

# P-phase re-verification (2026-07-31, execution cycle)

Stale check against the tree after WP1+WP2 (`33b94a534`). The route and CLI anchors in
this doc still resolve (`agent-settings-routes.ts` GET at 106 / PUT at 116, `cmdV2` at
`src/cli/v2.ts:76`, status at 82-93, `help.ts:225`), and neither target file has
uncommitted changes. The WP2 readers this phase consumes exist with the exact names
planned. Three amendments from the `005` staleness audit, all accepted.

## Amendment A — transaction rule for multi-key PUT

`005` finding: the doc left partial-success semantics undefined. Final rule for B:

1. **Validate everything first.** All six `wants*` type checks (old and new) run before
   ANY write — mode transition or scalar — so every 400 leaves the config untouched.
2. The mode/flag/thread transition keeps its existing all-or-nothing atomicity
   (`transitionMultiAgentV2` restores original bytes on failure).
3. The three new-key writes are then applied sequentially, each via its WP2 writer,
   which is individually atomic (`atomicWriteFile`). The keys do not interact, so a
   partial state requires an IO failure mid-sequence; in that case the route returns
   502 naming the writes that DID land, rather than pretending nothing happened.

This is the strongest guarantee available without adding a cross-key transaction
mechanism, and it matches the route's existing character (mode persistence to
OpenCodex config already happens outside the native transition's atomicity).

## Amendment B — rename the depth-applicability field

`agentsMaxDepthAppliesToActiveBackend` claims a per-model "active backend" the
endpoint cannot know: under default mode, per-model upstream pins choose V1 or V2, so
no single global answer exists. The derivable, honest field is the global-flag
statement, renamed accordingly:

```
agentsMaxDepthAppliesWhenV2Disabled  // boolean: !isMultiAgentV2Enabled()
```

Criterion 5 is restated against this name. The semantics are unchanged from the doc:
server-side derivation so no client can present `max_depth` as an effective V2 limit.

## Amendment C — CLI stays read-only; help.ts unchanged

`ocx v2 status` reads local files, so the three WP2 readers are printed there with no
new subcommand. `src/cli/help.ts` needs no edit (usage line unchanged), and
`tests/cli-headless-parity.test.ts` only maps the route name — the change map's
suggestion that it "may need updating" is stale; it does not.

The GUI remains the only writer of the new keys, exactly as the doc's Diff 4 fallback
allows; this is recorded here so D does not have to re-decide it.

---

# A-phase fold-back, execution cycle (verdict GO-WITH-FIXES, 3 blockers)

Independent terra review (Dirac). All three accepted and folded; near-pass with zero
residual.

## Blocker 1 (accepted) — the route preflights the i32 range as a 400

Amendment A's "validate everything first" only works if validation is COMPLETE. The
landed WP2 writer rejects out-of-i32 `max_depth`, so a route that accepts any integer
would convert a client mistake into a mid-sequence writer failure. Final rule: the
route preflights `Number.isInteger(value) && value >= -2_147_483_648 &&
value <= 2_147_483_647` and returns a field-specific 400, keeping 502 reserved for
real persistence failures.

## Blocker 2 (accepted) — writer failure handling is specified for both failure modes

The WP2 writers have two failure modes: `{ ok: false }` (unreadable config) and a
THROW from `atomicWriteFile` (`src/config.ts:105-137`). Final shape for B: a per-write
wrapper that try/catches each call and checks `result.ok`; on either failure the route
returns 502 naming the failed key AND the requested writes that already landed
(changed or no-op). Ordering, confirmed against the current route body:

```
validate all fields (all 400s here)
-> transitionMultiAgentV2 (existing all-or-nothing)
-> persist config.multiAgentMode (existing)
-> sequential new-key writes, wrapped as above
-> derive agentsEnabled/V2 warning + response fields from FRESH readers
   (readConfigText is uncached readFileSync — features.ts:56-63 — so post-write
   reads observe the bytes just written)
-> refreshCodexCatalogBestEffort() (stays last, after every config write)
```

## Blocker 3 (accepted) — the "GUI is the only writer" claim was false

The GUI currently PUTs only `multiAgentMode` and `maxConcurrentThreadsPerSession`
(`gui/src/pages/Models.tsx:467-471`, `:502-505`). Corrected scope statement: WP3 adds
management-API writes and CLI read-only reporting; GUI integration is explicitly OUT
(it would mean `models-shared.ts`, `Models.tsx`, translations, and GUI tests — a
separate phase if ever wanted). Additive GET fields need no GUI type change while
unused: `V2Status` is manually projected (`gui/src/pages/models-shared.ts:48-53`).

## Verified during this round

- The existing "status lines describe" test asserts only `v2StatusLine()` ON/OFF, so
  added status lines break nothing; B adds a `cmdV2(["status"])` capture test for the
  three values, null/empty rendering, and the V1-only label.
- All `/api/v2` tests use `toMatchObject`, so additive response fields break nothing.
- All six WP2 exports exist at `src/codex/features.ts` (confirmed by grep).
