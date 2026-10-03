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
with exit 2; `v2` remains human-output only.

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

- Local `provider add <name> --json` returns `needsSync: true`. It returns before the
  human-output `--sync` path; even both flags together do not prove live apply.
- `models preset apply` can return `fallback: "preset-empty"`; selection is then
  unchanged. Read `models selected <provider> --json` to check the effective list.
- Client integration results can preserve saved intent while reporting individual
  refused profiles. Inspect each profile and re-read status; partial is not full success.
- `account pause-exhausted` includes `failedAccountCount`. Failed quota reads do
  not establish that those accounts still have capacity.

A local save or an accepted update is not proof that a client has reloaded its
files. Do not automatically repeat a write whose apply or transport outcome is
uncertain; read back first and preserve the reported limitations.
