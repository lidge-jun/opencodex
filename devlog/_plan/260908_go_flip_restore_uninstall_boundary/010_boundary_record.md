# restore / uninstall / recover-history stay TypeScript-owned

Status: open (unit closes when any of the three gains a byte-parity oracle)

Origin: issue #52 continuation review — "flip connect/disconnect/restore/
recover-history/uninstall to Go (state transactions)". `connect status` and
`disconnect` flipped in `ed8a2afab`. This unit records why the remaining three
local-teardown commands are **not** portable the way `disconnect` was, backed
by reproduction runs against the TypeScript CLI on seeded homes.

## What each command actually does (source map)

- `ocx restore [back]` — `src/cli/dispatch.ts` `restore:` case →
  `restoreNativeCodexAsync` (`src/codex/inject.ts:1793`). Not a journal-only
  rollback: it runs desired-state persistence (`setIntegrationEnabled`,
  `src/codex/desired-state.ts`, recorded in `config.json.clientIntegrations`),
  an ownership preflight (`inspectNativeCodexOwnership`), the Codex write
  coordinator protocol (`codexWriteCoordinationEligibility` +
  `withCodexWriteLock` + `beginTransition` — coordinator SQLite, tx receipts,
  pre-image capture/compensation), `restoreCodexConfigInline`, catalog
  artifact restore (`model_catalog_json`), an asynchronous history job
  (`runCodexHistoryJob`), and `stripGrokConfig` (`src/grok/…`). `restore back`
  is the reverse inject and needs a **live proxy** + model sync.
- `ocx uninstall` — `src/cli/index.ts` `handleUninstall`: platform service
  manager stop/removal, identity-checked proxy shutdown with the tri-state
  "proven down" probe (#3008), shim/tray/launcher removal, system env var and
  shell hook removal, then the Codex/Grok native restore and the
  ownership-metadata-gated config directory removal.
- `ocx recover-history` — `handleRecoverHistory` →
  `runCodexHistoryJob({ operation: "recover-legacy-openai" })`: a
  manifest-independent force-relabel of every user-message history row to
  openai, executed through the history write-lock substrate over the real
  Codex resume-history SQLite.

## Reproduction evidence (2026-09-08, Linux, TS CLI `fa8adea97` head)

Seed: temp `OPENCODEX_HOME` + `CODEX_HOME/codex` with an injected
`config.toml`, a process-owned `opencodex-journal.json`, and a minimal
`config.json` (providers/defaultProvider).

`ocx restore --json` on that home (exit 0):

- stdout envelope `artifacts.config.action="journal-restored"`,
  `catalog.state="ok"`, `history.state="ok"`, rows 0.
- file deltas: `codex/config.toml` rewritten to the journal original;
  `codex/opencodex-journal.json` removed; **added**
  `config-mutation.sqlite` **and** `integrations/codex.json`;
  `config.json` gained `clientIntegrations.codex: false` plus schema
  defaults materialised.
- `integrations/codex.json` provenance entries carry `at` (wall clock) and
  `txId` (UUID) — a second run on the same home emits a different timestamp,
  and a Go implementation would emit different UUIDs/timestamps too. The
  byte tree is **non-deterministic by construction**.

`ocx uninstall` on the same home (exit 1, one failed step):

- "not installed" for service/shim/tray steps (platform-manager probes),
  native Codex restored (journal removed, config.toml rolled back, the same
  `integrations/codex.json` OWN metadata written), then
  `refused uninstall: config ownership metadata is missing or invalid` — the
  config-directory removal is gated on fresh-install ownership metadata, so
  the interesting legacy behavior is a refusal, not a file transaction.

`ocx recover-history --legacy-openai --yes` on an empty-history home:
converged with 0 rows, exit 0, zero file deltas. With real history present it
is a SQLite migration over thread/rollout state that no stdlib-only Go port
can reproduce, and the whole command exists for pre-backup legacy recovery
that cannot be fixture-seeded faithfully.

## Why the `disconnect` oracle pattern cannot carry these

`disconnect` is a *closed set*: it either owns every artifact (journal owner
== connected key, token fingerprint match, catalog fingerprint match) or
refuses. Every write is deletion/restore of bytes we already hold, so TS vs
Go byte trees converge. The three commands above are *open sets* by design:

1. **Non-deterministic bytes.** `integrations/codex.json` embeds `at`
   timestamps and `txId` UUIDs; the coordinator database records
   transition timing. Byte-diff oracles would need per-file semantic masks,
   which is the "both halves agree with each other, both wrong" trap the
   repo's parity discipline exists to prevent.
2. **Concurrent/asynchronous substrate.** The Codex write coordinator
   (lock acquisition, adoption, tx publication) and the history worker run
   outside the synchronous command; a tree snapshot races the worker.
3. **Platform surface.** `uninstall` touches service managers, the
   autostart shim, shell hooks and system env vars; behavior differs per OS
   and cannot close on a single-platform oracle.
4. **Live / legacy dependencies.** `restore back` requires a running proxy
   and model sync; `recover-history` mutates real resume-history databases
   that a fixture cannot faithfully stand in for.

Repo rule applied (from the #38/#44 flip notes): never mark a command native
without a passing byte-parity oracle. `restore`, `uninstall`, and
`recover-history` remain TypeScript-owned in `go/internal/ocxcli/cli.go`;
the Go-owned surface for the family is exactly `ocx connect status` and
`ocx disconnect` (`ed8a2afab`).

## Prerequisites for a future flip

- Go-side `integrations/*.json` OWN-metadata writer plus the Codex write
  coordinator and history-job substrate (modernc SQLite already lands in
  `go/internal/configschema`; the coordinator/history layers do not exist).
- An oracle that either runs both CLIs against the same wall-clock window
  and masks `at`/`txId`, or fixtures the coordinator empty and pins the
  legacy-uncoordinated path — accepted deliberately, not by default.
- `uninstall` additionally needs per-OS oracle lanes (systemd/launchd/
  Windows Task Scheduler) before it can leave the service subsystem.
