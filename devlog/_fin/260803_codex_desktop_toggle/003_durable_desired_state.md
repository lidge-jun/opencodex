# Desired state vs observed state — the thing this unit actually needs

Research doc. It replaces the durable-operation-state design `000_plan.md` WP1
asked for. That design solved crash recovery; the evidence says the real defect
is that a switch has no memory.

## The requirement, stated exactly

"Turning a switch off must leave the proxy running and serving every other
client. I might want everything except Codex on."

That has two halves, and only the first was ever examined:

1. **The mutation must not stop the proxy.** Already true for Codex
   (`001_native_restore_thesis.md`) and for the two shipped toggles.
2. **The OFF must survive.** Not true today for anything except Claude Code.

## The distinction everything turns on

| | Desired state | Observed state |
|---|---|---|
| Means | what the user asked for | what is currently on disk |
| Survives a restart | yes | only accidentally |
| Can gate an automatic path | yes | no — it IS the thing the path rewrites |

Almost every artifact we have is observed, not desired:

| Artifact | Which | Client |
|---|---|---|
| `config.claudeCode.enabled` | **desired** | Claude Code |
| `claudeCode.desktopAutoApply` | desired *policy*, but only "auto-rewrite a saved profile" — not "Desktop is enabled" | Claude Desktop |
| `desktopProfile.appliedFingerprint` / `appliedAt` | observed | Claude Desktop |
| Six-client ownership records | observed provenance — and **disable deletes the record** (`src/integrations/writer.ts:373-384`), so it structurally cannot carry an OFF | the six file clients |
| Grok fence presence | observed disk artifact (`src/grok/inspect.ts:19-44`) | Grok |
| Codex journal | observed recovery artifact (`src/codex/journal.ts:10-18`) | Codex |
| `codexAutoStart` | desired *lifecycle* policy; false makes `ocx ensure` skip the proxy entirely (`src/cli/index.ts:358-364`) | not a client flag at all |

The ownership-record row is the sharpest proof. A record that is deleted by the
very operation whose intent we want to remember can never be that memory.

## The shipped Grok toggle is already broken this way

Not a hypothetical. `PUT` OFF strips the fence and returns, persisting nothing
(`src/server/management/native-integration-routes.ts:228-256`). Then:

- every `ocx start` rewrites it (`src/cli/index.ts:334-341`)
- both branches of `ocx ensure` rewrite it (`src/cli/index.ts:372-379`, `:398-404`)
- service start, login start, dashboard restart and tray restart all funnel into
  startup (`src/service.ts:318-340`, `src/server/management/system-restart.ts:90-170`)
- `POST /api/grok/apply` regenerates it directly (`agent-settings-routes.ts:639-652`)

`syncGrokConfig` has no enabled check at all (`src/grok/sync.ts:29-65`). So a
user who turns Grok off gets it back on the next restart, silently. That is a
regression against the switch we shipped hours ago, and it lands in this unit
because the fix is the same schema.

Claude Code is the counter-example that proves the shape works: `enabled` is
persisted and every automatic consumer honors it — system env
(`src/server/system-env.ts:251-256`), the launcher (`src/cli/claude.ts:236-242`),
agent sync (`src/claude/agents-inject.ts:247-254`), inbound
(`src/server/claude-messages.ts:65-69`), model discovery
(`src/server/index.ts:493-502`).

## Codex's automatic re-apply paths

All ungated today:

| Path | Trigger |
|---|---|
| `ocx start` | every proxy start (`src/cli/index.ts:318-341`) |
| `ocx ensure` (both branches) | tray, restart, many commands (`src/cli/index.ts:365-411`) |
| `POST /api/sync` | dashboard sync (`config-routes.ts:261-268`) |
| `ocx sync`, `ocx restore back` | explicit, but should still respect OFF |
| `ocx models custom add/remove` | any custom-model edit with a live proxy (`src/cli/models.ts:102-206`) |
| provider/model/combo mutations | via `refreshCodexCatalogBestEffort` (`management-api.ts:105-112`) — catalog only, not injection |

The last row matters for scoping: provider and model mutations rewrite catalog
artifacts but do NOT call `injectCodexConfig`, so they need their own gate rather
than riding on the sync gate.

`ocx opencode` deserves its own line: it injects `provider.opencodex` inline via
`OPENCODE_CONFIG_CONTENT`, and that inline layer outranks disk config
(`src/cli/opencode.ts:461-477,531-572`). The six file clients look safe from
auto-reapply only because no automatic writer calls them — an accident, not a
guarantee — and this path already bypasses it.

## The schema

In `OcxConfig`, not the integrations store — the store holds observed state by
construction:

```ts
type ClientIntegrationId =
  | "codex" | "claude-code" | "claude-desktop" | "grok"
  | "opencode" | "pi" | "hermes" | "openclaw" | "kimi" | "gajae";

clientIntegrations?: Partial<Record<ClientIntegrationId, boolean>>;
```

Effective state is `config.clientIntegrations?.[client] !== false`. A missing
map, a missing key, and an explicit `true` all mean ON, so **no existing setup
changes behavior on upgrade**. That defaulting is not a convenience; it is the
only acceptable migration for a feature that can silently unplug someone's
working client.

Compatibility rules:

- `claude-code` absent → fall back to `config.claudeCode?.enabled !== false`, and
  mirror both during the transition, so an existing Claude OFF never migrates
  itself back to ON.
- Never infer Desktop OFF from `desktopAutoApply: false`. Different intent.
- **Desired intent persists independently of mutation success.** If a disable
  hits an ownership refusal or drift, keep desired `false` and report
  "desired OFF, observed conflict". Otherwise the next automatic path quietly
  undoes what the user asked for.

## What must NOT be gated

A gate in the wrong place turns a safety mechanism off:

- Codex crash-journal reconciliation (`src/codex/journal.ts:148-162`) — it repairs
  our own stale state.
- Ownership, drift and compare-before-write checks (`src/integrations/writer.ts:171-223`).
- Owned teardown on stop/uninstall (`src/service.ts:2587-2594`). Stopping the
  service must never rewrite desired ON into OFF.
- Grok's non-loopback credential-safety cleanup (`src/grok/inject.ts:359-380`).
- **Shared transports.** Codex OFF must not disable `/v1/responses`, which other
  clients use; Claude Code and Desktop flags must not shut down their shared
  `/v1/messages`. Disabling an integration means "stop writing into that client's
  config", never "stop serving".

That last rule is the user's requirement restated as an invariant, and it is the
one an implementer is most likely to violate while feeling productive.
