# JSON shapes

Selected response shapes and fields to inspect. These are command-specific examples,
not a universal schema; check the installed leaf help and the actual receipt.

## Output modes

`ocx capabilities --json` reports which style each verb uses, as `json: "payload"` or
`json: "envelope"`.

- **payload** — the management response, largely unwrapped. `ocx usage --json` returns the server
  payload untouched.
- **envelope** — a CLI-shaped object with its own schema, usually carrying `ok: true` plus the
  fields the verb operated on.
- **none** — the verb has no `--json` mode.

Output flags are parsed by each command, not globally. Preserve the documented
operand order; do not add `--json` to a leaf marked `none`. `doctor` rejects it
with exit 2. `v2` supports `--json` for both local and explicit `--live` targets.

## `ocx ready --json`

```json
{"ready":true,"status":"ready","pid":1443,"port":10100}
```

A readiness probe, not a start command. `ready: false` can mean `pending`,
`failed` or `unreachable`; only `pending` describes startup still in progress.

## `ocx status --json`

Carries `schemaVersion`, then `proxy.running`, `proxy.pid`, `proxy.health.ok`, and a `dashboard`
section. This is also where a version skew between your binary and the running proxy shows up —
check `versionSkew.relation` before trusting flags you just read about.
`match` confirms version equality; `unknown` is not a match.

## `ocx logs --jsonl`

One row per line. The fields worth branching on:

| Field | Meaning |
|---|---|
| `requestId` | pass to `ocx logs explain` |
| `conversationId` | groups a conversation; also printed as `conv=<id>` in human output |
| `accountLogLabel` | which account served it (`main`, `p<hex6>`, `o<hex6>`); also printed as `acct=<label>` in human output |
| `provider` / `model` | what actually served it |
| `requestedModel` / `requestedAlias` | what the client asked for |
| `status` / `durationMs` | outcome |
| `usageStatus` | `reported`, `estimated`, `unreported`, or `unsupported` |
| `attempts[]` | one entry per try, each with its own `provider`, `model`, `status` |
| `routeDecision` | why this route won |

`requestedModel` and `model` differ whenever routing or failover intervened. Attributing a request
to `requestedModel` is how you get a wrong answer about which provider served it.

`usageStatus: "estimated"` means the numbers are derived, not reported by the provider.
`displayMetrics.cost.estimate.estimateReasons` lists why — for example `usage_estimated`,
`cache_detail_missing`, `expected_price_overlay`.

## `ocx provider list --jsonl`

One configured provider per line. Each object has the same fields as an item in the
`configured` array from `ocx provider list --json`; the `registryCount` summary is omitted.

## `ocx logs explain <request-id>`

```json
{"requestId":"ocx-…","routeDecision":{"version":1,"decisionId":"…","requestedModel":"kiro/claude-opus-5",
 "routeKind":"explicit-provider","requirements":[],
 "candidates":[{"provider":"kiro","model":"claude-opus-5","eligible":true,"exclusions":[]}],
 "selected":{"candidateIndex":0,"provider":"kiro","model":"claude-opus-5","reason":"explicit-provider-namespace"}}}
```

`candidates[].exclusions` is the useful part when a route surprised you: it says why each
non-winner was rejected. `selected.reason` names the rule that decided it.

## `ocx usage --json`

`summary`, then `providers[]`, `models[]`, `days[]`, and `accounts[]`. Costs appear as
`estimatedCostUsd`.

Two honesty markers to respect:

- `accounts[].ambiguous === true` (label `legacy-ambiguous`) aggregates several accounts from
  before per-account labelling. Not one identity.
- Under `--provider` or `--model`, per-account rows are **withheld** rather than filtered, because
  account totals cannot be honestly re-partitioned by provider.

## `ocx account list <provider> --json`

`accounts[]` with `id`, `email`, `plan`, `paused`, `selected`, `priority`, and `needsReauth`. Quota
appears only under `--quota`.

`paused` and `selected` are independent — a paused-but-selected account still receives requests.

## Pool settings

`ocx account strategy|sticky <provider> --json` returns pool-neutral keys:

```json
{"ok":true,"provider":"openai","strategy":"quota","stickyLimit":1}
```

The underlying routes disagree about names — the Codex pool uses `accountPoolStrategy` and
`accountPoolStickyLimit`, the Anthropic pool uses `strategy` and `stickyLimit` — and the CLI
normalizes both so you do not branch on which pool answered.

The value returned is the **applied** one after server normalization, not what you sent.

## `ocx storage cleanup --percent N --json` (preview)

```json
{"percent":25,"count":3,"bytes":3145728,"digest":"…","candidates":[{"relPath":"archived_sessions/….jsonl","bytes":1048576,"mtimeMs":…}]}
```

`count` and `bytes` are what you report to the user. `candidates[]` is capped at 50 rows, but
`count` and `bytes` describe the whole set.

`digest` binds a run to this preview; the mutating call must carry it and the server rejects a stale
one with 409. The CLI handles that for you — it always previews first.

## Error shape

A management error normally prints a message and optional reason/hint on stderr
and returns a non-zero code; recovery details can add further lines:

```
Error: <message>
reason: <machine-readable reason>
hint: <what to do>
```

Use `reason` when present, but it is optional; retain the exit code and stderr
when absent. Nested server error objects do not have a universal CLI decoder. `--json` does **not** wrap
API failures in `{error:{type,code,message}}`; `runCliAction` still prints prose on
stderr and returns 4/5/1. Do not parse stdout for an error envelope that is not there.

## Saved, applied, skipped and partial

- Local `provider add <name> --json` returns `needsSync: true` unless an explicitly
  requested `--sync` succeeds with `sync.status: "applied"` and `sync.ok: true`.
  JSON output does not suppress sync. `sync` is omitted when not requested.
- `models preset apply` can return `fallback: "preset-empty"`; selection is then
  unchanged. Read `models selected <provider> --json` to check the effective list.
- Client integration results can preserve saved intent while reporting individual
  refused profiles. Inspect each profile and re-read status; partial is not full success.
- `account pause-exhausted` includes `failedAccountCount`. Failed quota reads do
  not establish that those accounts still have capacity.

A local save or an accepted update is not proof that a client has reloaded its
files. Do not automatically repeat a write whose apply or transport outcome is
uncertain; read back first and preserve the reported limitations.

## Provider write receipts

Live add, remove, default selection, pacing and batch apply retain a validated
public receipt. Fields vary by operation: `name`, `defaultProvider`,
`droppedCustomModels`, `disabled`, `hasApiKey`, `xaiResponsesOptInState`,
`dependentShadowIntercept` and `catalogRefresh` are optional. These examples are
complete possible receipts, not a promise that every operation has each field.

Saved and catalog committed (exit 0):

```json
{"success":true,"name":"example","catalogRefresh":{"status":"committed","changed":true,"degraded":false,"notices":[]}}
```

Saved but not converged (exit 1, still JSON on stdout):

```json
{"success":true,"name":"example","catalogRefresh":{"status":"skipped","reason":"busy","retryable":true}}
```

A failed catalog refresh also exits 1. `committed` can report `degraded: true`
and notices; preserve those qualifications. `skipped` reasons `busy`, `stale`,
`refused` and `catalog-unavailable` mean convergence remains pending. An absent,
null or `skipped/not-requested` refresh can exit 0 without establishing a client
sync. `retryable: true` is not authority to repeat the provider write.

Local add has a different receipt: `action`, `provider`, `adapter`, `baseUrl`,
`defaultModel`, `isDefault`, `source`, `modelSelection`, and `needsSync`. Requested
sync adds `sync: {status, ok}`. A stopped proxy yields `sync: {"status":"not-running",
"ok":false}`, `needsSync: true` and exit 1; the local provider is still saved.
`failed` and `refused` also return nonzero. `skipped` or `catalog-only` with
`ok: true` may exit 0 while retaining `needsSync: true`.

## Provider editor and pacing reads

`provider snapshot --json` returns exactly `{defaultProvider, providers}`: a
redacted, validated editor document, with no receipt wrapper. Keep it unchanged
as a batch baseline. Credentials, `headers` and GUI-only markers are not editable
fields; raw config export is a separate human-only handoff.

`provider pacing <name> --json` separates stored rules from runtime observations:

```json
{"provider":"example","rules":null,"status":{"provider":"example","enabled":false,"queued":0,"nextSlotInMs":0}}
```

`rules: null` means unconfigured, not a failed read. `status` can also include
`inFlight`, `lastStartedAt` and `lastModelId`; it is not an editable rules object.
HTTP errors still produce fixed prose on stderr and nonzero exit, not a JSON
error envelope. A stale editor baseline returns exit 5; see
[failure recovery](04_failure_semantics.md#provider-save-and-convergence-failures).

Local requested sync also reports `configApplied` and `catalog: {exists,written,cacheSynced,converged}` when the backend returned a result. Its normalized `ok` requires catalog convergence for applied/catalog-only results. A successful config injection with a failed or refused catalog keeps `needsSync: true` and exits 1. An unchanged existing catalog can have `written: false` and `cacheSynced: false` while still converged; write counts alone do not establish failure. Raw backend warning strings and private paths are not emitted.

## Model and routing write results

Local custom-model add/remove JSON is `{action, model, needsSync, sync}`. `action`
is `added` or `removed`; removal retains `model.id`, `model.provider`, `model.modelId`.
With no proxy, `sync` is `{"status":"not-attempted","ok":false}` and exit is 0
with `needsSync: true`: synchronization is opportunistic. Attempted sync can also
report `configApplied` and `catalog: {exists, written, cacheSynced, converged}`.
Only complete applied sync clears `needsSync`; attempted failures/refusals are nonzero.

Live custom add instead returns the stored entry (`id`, `provider`, `modelId`,
`addedAt`, optional metadata) plus `catalogRefresh`. Live remove returns
`{ok, id, provider, modelId, catalogRefresh}`. Display-name writes return
`{ok, provider, modelId, displayNameOverride, displayName, displayNameSource, catalogRefresh}`;
source is `operator`, `provider` or `fallback`. A recognized saved-but-failed-refresh
response instead has `saved: true`, provider/modelId/override and failed
`catalogRefresh`, with exit 1.

Order status returns `pickerOrder`, `pickerOrderMode`, routed-only `pickerAvailable`
and `chosen` when known. A bare native saved ID is retained in `pickerOrder` even
though absent from `pickerAvailable`. Missing `chosen` means unknown featured
state. Order writes return `{ok, pickerOrder, pickerOrderMode, applied, force,
catalogRefresh}`. Here `applied` is the featured roster, not client synchronization.
Reset returns an empty saved order and null mode; it does not clear featured models.

Profile show is the profile itself, with `id`, public `model`, opaque `revision`,
and editable fields. Create/update returns `{success, id, model, profile,
catalogRefresh}`; the new revision is `profile.revision`. Remove returns
`{success, id, catalogRefresh}`. Combo set returns `{success, id, model, combo,
catalogRefresh}`. Neither show metadata nor the write envelope is a file input.

For these new live custom/order/display/profile writes and combo set, only a
committed, nondegraded catalog refresh returns 0. Failed, skipped or degraded
refresh preserves the saved domain receipt but returns 1. This is stricter than
the provider-write receipt above; do not apply one exit rule to every command.

## `ocx combo stats <stored-id> --json`

The response has `comboId`, `range`, `since`, optional `until`, `generatedAt`,
`summary`, `gates`, `backends`, `models`, and snapshot/history coverage fields.
Useful `summary` pairs are `measuredModelAttempts/modelAttempts` and
`decisionUsageReported/decisions`. Model token totals and decision token totals
are separate observations. `averageLatencyMs`, `averageConfidence` and
`averageChosenProbability` may be null. Zero decisions means no recorded
observations in that window, not a successful or free run.

Preserve `usageIncomplete`/`usageIncompleteReason`, `historyTruncated`,
`truncatedPrefixBytes`, `entriesTruncated`, `entriesDropped`,
`snapshotWindowStart` and `snapshotWindowEnd` when reporting coverage. Per-model
rows retain `overflow` and nullable effort buckets. Missing/invalid required
measurements cause refusal rather than fabricated zeros. No cost or savings
field exists in this DTO.

## Account policy receipts

`account pool P --json` returns `provider`, `kind`, `supported`, `enabled`,
`enabledEffective`, `strategy`, `stickyLimit`, `autoSwitchThreshold`, `quotaWindow`,
`maxConcurrentPerAccount`, `routes`, and optional `routesError`/`inert`. Preserve
nullable stored fields; `enabledEffective` is the effective boolean. `supported`
lists writable fields, not a guarantee of account availability. `inert: true`
must not be presented as active pooling.

Per-account OpenAI threshold reads/writes return `{ok, id,
autoSwitchThresholdOverride, autoSwitchThreshold}`. Null override means inheritance;
the effective value is separately observed. Credits for one return
`{ok, id, creditsAfterLimit}`; all returns `{ok, all, ids}` using the actual applied
IDs. Quota activation returns `{ok, id, window, enabled, available}`, with window
`fiveHour` or `weekly`; this is not a completed-refresh or reset-consumption receipt.

Anthropic reset-grants returns `accountId`, `eligible`, nullable `ineligibleReason`,
`atLimit`, `grants`, nullable `nextGrantId`, `weeklyResetsAt`, `cooldownUntil`,
`pendingOperation`, and `journalAvailable`. Grants preserve counts, nullable dates,
`clears`, `paused`, `usableNow`, `useRequiresLimit` and observed `percentUsed`.
Pending operation contains operation/grant IDs and timing; it is never an instruction
to resume spending. Empty grants and unavailable status differ.

Login start/status returns the flow's public URL/device instructions and safe state;
fields vary by flow. `flowId`, account identity and device code are different.
`browserLaunch` is `started`, `failed` or `skipped` when reported. Preserve
`validationPending` and `catalogRefreshPending`; `--no-wait` does not mean done.
Live OAuth logout returns `{schemaVersion:1, success:true, provider, live:true}`.
Local logout instead uses `{schemaVersion:1, ok, provider, removed}`, with
`reason:"not_found"` and exit 4 when absent. Never invent `removed` for live logout.

## Settings and v2 receipts

Memory/compaction reads are `{memoryModels: blockOrNull}` or
`{compactionRouting: blockOrNull}`. Writes add `catalogRefreshPending`: false exits
0 without proving every client applied, true exits 1 after saving. Missing/malformed
pending evidence becomes null plus `verification:"unverified"` and exit 1.
An empty memory block stays `{}`; clear stays null. Neither stops the pipeline.

New-option system writes return `{ok:true, settings: observedFields,
catalogRefreshPending}` plus relevant `desktop` stored/effective/apply facts when
requested. Unverified read-back adds `verification:"unverified"` and
`unverifiedFields`; Ultra Fast is read back because PUT does not return it. Never
replace missing evidence with the requested value. Pending or native apply refusal
can also make the saved result nonzero.

Injection default-sync writes return `{ok, multiAgentGuidanceEnabled,
syncCodexSubagentDefaults, model, effort, prompt}` with actual normalized values.
New sidecar-option writes return `{ok, webSearch|vision, codexWebSearch}`; the selected
section contains validated public fields only. `codexWebSearch` is `{applied:true}`
or `{applied:false, reason, retryable}`. An unverified new field is marked as such;
deferred/refused apply differs from saved settings. Read sidecar status for complete
observed settings, including supported web reasoning.

Local v2 JSON is `{ok, target:"local", action, changed, state, sync}`. `changed`
can be null when unknown; `state` can be null after read-back failure. Status,
threads, hints and unchanged toggles can have `sync.status:"not-attempted"` without
failure. Attempted sync includes safe config/catalog evidence; an unusable result
is `{status:"unverified",ok:false}` and exits 1. It never fabricates server receipts.
Live status has `target:"live"` plus validated v2 state, surface advisory and hint
recommendation. Live writes add `ok:true` and full `catalogRefresh`; committed,
nondegraded convergence is required for exit 0. These are distinct from settings'
boolean pending flag.

## Integration preview and recovery receipts

Preview JSON is one validated version-1 plan: `clientId`, `operation`, optional
`profileId`, `state`, `foreignEdit`, ordered `changes:[{kind,path}]`, `fingerprint`,
`canApply`, `willChange`, and `refusalReason` when refused. It contains structural
paths, not values. A valid refused or no-op preview exits 0; no mutation is implied.
Only an applicable bound `pN:<32 lowercase hex>` token is a commit input.
`pN:unbound` can describe refusal but cannot authorize or bind a write.

Stale bound writes emit no stdout, fixed re-preview guidance on stderr and exit 5.
They do not emit or auto-adopt a replacement plan. Successful mutation receipts
contain `ok`, `clientId`, `state`, invocation-derived `operation`, optional
`profileId`, `changed`, `opId`, `reason`, `residual`, and a separately labeled,
redacted `snapshotPath` where supplied. A valid `ok:false` receipt exits 1;
HTTP failures use their mapped exit and stderr instead of an invented JSON error.

Journal deletion returns `{ok:true, opId, clientId, snapshotRemoved}` with optional
`profileId`. False snapshot removal is committed retirement with incomplete cleanup
and exit 1. Aside sync returns `{results:[...]}`; rows identify `client:"aside"`
and `profileId`, then success `ok/changed` or refusal `ok/state/refusalReason/reason`
and optional residual/backup facts. Empty results exit 0; any failed row exits 1.

## Desktop, Cursor and Hub observations

Runtime Desktop profile show returns `{profile, models, rendered, port}`; import
adds `ok:true`. The profile is versioned assignments/defaults with applied markers
when present. Models carry availability and assignment facts; rendered rows are
not proof that a native client applied them. Import is save-only.

Cursor status projects `privateInference`, `regularCursor`, `gateway`, `lastSeen`,
`effortTable`, `models`, `guideUrl`. Gateway `apiKeyMode` is `credential` or
`placeholder`, without returning a credential. Installer lookup is
`{available,url,version,reason}`; unavailable means null URL/version and can have
null reason. Both are observations with exit 0 when valid, never install receipts.

Available Hub status is `{available:true,devices,runtimes,sessions}`. Runtimes
reads return `{runtimes:{codex:{available,...},claude:{available,...},pi:{available,...}}}`;
session reads return `{sessions:[...]}`. Device roots expose IDs/labels, not executor
filesystem paths. Session events are public observed text with sequence/time/type;
terminal rendering escapes controls. Empty lists on an available Hub succeed.

Disabled Hub observation (outer HTTP 200) instead prints `available:false`, a fixed
activation/Hub reason, `devices:[]`, `runtimes:{}`, `sessions:[]` and exits 1. Inner
HTTP 409 exits 5 with stderr and no fabricated empty success.

## Maintenance receipts

New storage policy setters return `{ok:true,policy,job:{status}}`. Policy preserves
`enabled`, nested `trigger:{archivedBytesOver}`, one target (`reduceToBytes` or
`removeOldestPercent`), mode, schedule and optional last/next-run facts. Job status
`idle`/`running` is observed state, not evidence this setter started cleanup.

Forced link revocation returns `{linkId,remoteCleanup,recovery}`. Cleanup is
`skipped` after a successful forced write, or `unverified` after idempotent
link-not-found. This field comes from explicit CLI force intent, not a server
cleanup report. Both can exit 0 while remote client recovery remains outstanding.
