# Client integration switches: Codex, Claude Desktop, and the memory they need

Split out of `260803_integrations_toggle_all` after its fourth audit. That unit
shipped Claude Code and Grok. This one was scoped around a durable
operation-state engine — and a research cycle against the real code says that
engine solves the wrong problem.

> **Re-planned 260803 after four research passes.** The rollback engine
> (`010_operation_state.md`, never written) is **dropped**. Evidence:
> `001`-`004`. The replacement is smaller, and it also fixes a defect in the
> toggle we shipped hours ago.

## The requirement in the owner's words

> "스위치를 꺼도 프록시는 살아있어야 돼. 코덱스 말고 다른 것만 켜고 싶을 수도 있잖아."

Turning a client off must leave the proxy running and serving every other
client. That is two obligations: the mutation must not stop the proxy, and the
OFF must survive a restart.

## What the research changed

| Prior claim | What the code says |
|---|---|
| Codex needs a durable operation-state engine | `ocx restore` already restores native Codex **without stopping the proxy** (`src/cli/help.ts:18`), and `ocx restore back` is the enable direction. Both exist. (`001`) |
| Desktop removal is impossible to do safely | Anthropic documents that a selected config without a valid `inferenceProvider` launches **standard mode**. We aim at that instead of guessing. (`002`) |
| The missing piece is crash recovery | The missing piece is **desired state**. Only Claude Code has one; Grok's shipped toggle is silently re-enabled by the next `ocx start`. (`003`) |

The fourth research doc (`004`) is an unrelated live defect found while looking:
one out-of-enum modality value makes a client reject its entire config. It joins
this unit as an independent work-phase (LOOP-UNIT-CHAIN-01).

## Read first

In this unit, all four written this cycle:

- `001_native_restore_thesis.md` — Codex restore, its asymmetries, the history lock
- `002_desktop_standard_mode.md` — the official standard-mode contract, and why `default` is not the restore verb
- `003_durable_desired_state.md` — desired vs observed, the Grok regression, the schema
- `004_export_modality_poisoning.md` — the gjc/Pi enum defect

From the parent unit, still authoritative: `001_removal_path_inventory.md`
(what each disable costs) and `002_consequence_dialog_ux.md` (dialog direction).
Its `007_audit_synthesis_r4.md` is the reason this unit exists, but its central
conclusion is now **superseded** by `001`-`003` here.

## Phases

**Re-sliced after audit round 2** (`006_audit_synthesis_r2.md`). The first map
sliced along a schema — one ten-key `clientIntegrations` map — which forced every
phase to touch every client's write path. Two audit rounds widened rather than
narrowed. This map slices along **ownership boundaries**: one client family per
phase, each independently auditable.

| Phase | Doc | Deliverable | Audit state |
|---|---|---|---|
| WP2 | `010_modality_boundary.md` | The client-dialect modality filter | **clean through two rounds** |
| WP3 | `020_api_keys_row.md` | API keys out of the card grid into their own row | never blocking |
| WP4 | `030_desired_state.md` → re-scoped | Desired state for **Codex only**, plus its gates, single-flight, ownership preflight and CLI semantics | re-scope pending |
| WP5 | `040_codex_toggle.md` | The Codex switch on WP4's flag | rewrite pending |
| WP6 | *(new doc)* | Grok's desired state, reusing the shape WP4 proved | not started |
| WP7 | `050_desktop_toggle.md` | The Desktop switch via documented standard mode | deferred behind WP5 |

The two pending docs were renamed so the decade order matches the phase order:
reading the unit lexicographically now gives the build order, which is the whole
point of the numbering convention.

WP1 was the research cycle plus this roadmap, twice audited.

WP2 and WP3 depend on nothing here and on each other not at all — they ship
first, alone, because each changes one thing at one boundary. That property is
the only thing that survived both audit rounds intact.

Three deliberate exclusions, each an accepted audit finding rather than a
convenience:

- **Claude Code's ingress gates are not touched at all.** Round 1 #1 established
  that `claudeCode.enabled` is the documented kill switch for `/v1/messages`;
  the honest conclusion is not to route it through a new helper in this unit.
- **The six file clients get no desired-state flag here.** Round 2 #4 (existing
  explicit OFF choices are not migrated) and #5 (a mutating GET) both belong to a
  phase that does not exist yet, and inventing it under audit pressure is what
  produced round 2's new findings.
- **Desktop is behind Codex, not beside it.** Round 2 #3 found no coherent rule
  when a foreign profile is selected. The goal explicitly permits an evidenced
  deferral; this is one.

## Scope boundary

IN: `src/clients/config-export.ts`, `src/types.ts`, `src/config.ts`,
`src/codex/sync.ts`, `src/grok/sync.ts`, `src/cli/index.ts`,
`src/cli/opencode.ts`, `src/claude/desktop-3p.ts`,
`src/server/management/native-integration-routes.ts`,
`src/server/management/agent-settings-routes.ts`, `src/server/management-api.ts`,
`gui/src/pages/integrations/*`, `gui/src/styles-integrations.css`,
`gui/src/i18n/*`, `tests/`, `gui/tests/`.

OUT: releases, publishing, deploys, tags; starring the repository; rewriting the
six-client file machinery in `src/integrations/`; `docs-site` restructuring;
recording the previous `appliedId` (deferred, `002` §Residual).

## Criteria

- C1 — gjc loads our emitted config with no schema error, proven from the real
  file; Pi's identical exposure is closed in the same change.
- C2 — Codex stays disabled across a proxy restart, an `ocx ensure`, and a
  `POST /api/sync`.
- C3 — an upgrading user with no `clientIntegrations` key sees no behavior change.
- C4 — disabling Codex never stops the proxy and never closes `/v1/responses`.
- C5 — Codex toggles both directions from the overview with the proxy running.
- C6 — a Codex disable blocked by the held history DB is an explained refusal
  naming the cause, never a raw 500 and never a false green.
- C7 — startup convergence never touches state owned by a service running from a
  different `OPENCODEX_HOME` (round 2 #2, blocking).
- C8 — API keys render as a row above the grid, observed rendered.
- C9 — typecheck, full test, gui lint, gui test, privacy scan all green.
- C10 — Desktop ships with a proven restore path OR is deferred with recorded
  evidence. Both outcomes close this criterion.

## Risk register

| Risk | Mitigation |
|---|---|
| A gate silently unplugs a working client on upgrade | Absent key means ON, everywhere, with a test for the absent-config case (`003`) |
| Gating a safety path | Explicit do-not-gate list: journal repair, ownership checks, owned teardown, shared transports (`003`) |
| Desktop pointed at a missing file | Never delete `appliedId`, never leave it dangling, never pick an entry by the name `Default` — this machine's `Default` is already dangling (`002`) |
| The modality fix erases valid internal metadata | Filter at the client-dialect boundary only; management and CLI keep carrying `audio` verbatim (`004`) |
| A green suite hides the real failure | 91 tests pass today beside a config gjc refuses to load. Every criterion names a live artifact, not a unit test |
| A repair introduces a worse defect than the one it fixes | Round 2 produced exactly this. One client family per phase, re-audited before the next starts — never a cross-client rewrite under audit pressure |
| Convergence tears down a foreign home's state | Every native remover runs `assertNativeTeardownOwned` before removal, and reconciliation runs only after service-ownership resolution (round 2 #2) |
