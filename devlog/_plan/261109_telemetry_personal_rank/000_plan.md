# Opt-in public profile and personal usage rank

## Objective and scope

Let a person who runs opencodex with anonymous telemetry on explicitly opt in to a **public profile** and
see where their own usage ranks: tokens, requests and model families over the last day, week and month,
on the dashboard Home and at `https://opencodex.me/dashboard`. Profiles are off by default, separate
from anonymous telemetry, revocable from the same card and from the CLI, and a disconnect deletes the
server-side profile and every row submitted for it.

Delivery is one pull request stacked on `goat/telemetry-06-dashboard` (#8308), retargeted to `dev` once
the telemetry stack (#8300 → #8348 → #8303 → #8304 → #8305 → #8308) has landed. The stack belongs to
another lane; this unit never pushes to its branches and merges their updates in (no rebase). No
deploy of the collector, no D1 database, no OAuth app, no DNS change: those are maintainer steps.

Prior art: [001_prior_art_tokscale.md](001_prior_art_tokscale.md).

## Owner decisions (2026-11-09)

| Id | Decision |
| --- | --- |
| scope | Supersedes the 261107 unit's "no per-user profiles or leaderboards" for **opt-in** profiles only. The anonymous dashboard stays as it is. |
| entry | The Home screen shows a Connect card while anonymous telemetry is effectively on (and whenever a profile is connected, so it can always be disconnected). |
| identity | v1 uses a chosen handle plus a server-issued secret. GitHub device-flow login is a follow-up: it needs a maintainer-created GitHub OAuth app (a cloud resource this unit may not create). No e-mail is ever asked for or shown. |
| fields | Public: handle, display name, avatar colour (closed palette, no image URLs), per-period totals and ranks, model-family totals. Nothing else. |
| cli | `ocx telemetry profile connect|disconnect|status`. |
| deploy | Collector code, schema and tests only. No cloud resources. |

## Privacy contract (stack-lane gates, 2026-11-09)

1. **Separate, explicit, human-only consent.** Connecting is never implied by the anonymous telemetry notice,
   its decision, or its default. It needs a dashboard session that is a human session
   (`hasHumanDashboardSession`) or an interactive TTY that is not agent-driven and not `OCX_SERVICE`
   (same `agent_consent_required` / `tty_required` refusals as `ocx telemetry enable`), and an explicit
   confirmation that defaults to **no**.
2. **No linkage to anonymous telemetry identifiers.** The profile never reads, derives from, sends or stores
   `telemetry-id.json`, `installId`, `installDayHash` or `batchId`. Profile submissions go to different
   endpoints on their own timer with independent jitter, carry a server-issued bearer secret, and contain no
   version, platform, channel, provider kind or error field. The anonymous rollup tables keep no per-install
   token or request totals, so a profile row cannot be joined back to an install by value.
3. **Independent state.** Declining or disabling anonymous telemetry never changes profile state, and connecting
   or disconnecting a profile never changes the telemetry decision, notice or state file. Profile *sending*
   additionally requires anonymous telemetry to be effective (env opt-outs, decline and `awaiting-notice`
   pause it, without touching the profile), because the profile is built from the same local daily aggregate
   and a person who turned telemetry off expects nothing to leave the machine.
4. **Aggregates only.** A profile day carries: the UTC day, total requests, five disjoint token buckets, and
   per model family (closed `MODEL_FAMILIES` roster) requests and tokens. Never prompts, outputs, keys,
   account ids, e-mails, provider names, base URLs, hostnames, paths or error text.
5. **No backfill.** Only completed UTC days strictly after the connect day are sent (client and collector both
   enforce it), at most one day per tick, at most 7 days old, never a day inside an env opt-out period.
6. **Deletion.** Disconnect calls `DELETE /v1/profiles/me`; the collector deletes the profile row and all its
   (Revocation is never gated: admin route and CLI always allowed, proxy running or not, anonymous telemetry on
   or off.)
   day rows in one batch. Until that succeeds the local file keeps the secret with `pendingDelete: true`,
   sends nothing, and retries on every tick; status shows "deletion pending".
7. **Secret handling.** The secret is shown to nobody: never in API responses, CLI output, logs or the GUI.
   Stored only in `<OPENCODEX_HOME>/telemetry-profile.json` (atomic no-follow write, 0600; the collector stores
   `sha256(secret)` only).
8. **Core path.** Nothing under `src/telemetry/profile/` is imported by `src/router.ts`,
   `src/server/lifecycle.ts` or `src/server/responses/core.ts`; it loads lazily from background lifecycle,
   the management dispatcher and the CLI.

## Work phases (one PR, one commit series)

| Goalplan | Doc | Thesis |
| --- | --- | --- |
| wp1 | this unit | Docs-first roadmap, audited. |
| wp2 | [010_client_core.md](010_client_core.md) | Profile contract, state file, collector client, sync tick, management routes, CLI, capability registry. |
| wp3 | [020_collector.md](020_collector.md) | D1 tables, profile + leaderboard endpoints, limits, abuse controls, pruning. |
| wp4 | [030_gui_card.md](030_gui_card.md) | Home Connect card with rank view and disconnect; 11 locales. |
| wp5 | [040_dashboard_leaderboard.md](040_dashboard_leaderboard.md) | docs-site leaderboard and personal-rank view; 8 locales. |
| wp6 | [050_docs_privacy.md](050_docs_privacy.md) | Guide, README + translations, code-signing pages, AGENTS_INSTALL, structure. |
| wp7 | [060_review_pr.md](060_review_pr.md) | Independent review, separate privacy review, PR, CI. |

The contract module lands first (wp2) because the collector imports it (collector-first rollout applies to
any later change of it, as for the anonymous contract).

## Verification floor

`bun run typecheck`; focused tests per layer (failing first for every behaviour); `bun run test:changed`;
`bun run structure:check`; `bun run privacy:scan`; file-size ratchet, test-layout and Lab-boundary guards;
`bun run skill:surface:check` (new CLI capabilities); `bun run lint:gui` + `bun run build:gui` (wp4);
docs-site build (wp5/wp6); all in isolated homes (`env -i`, temp `HOME`/`OPENCODEX_HOME`/`CODEX_HOME`/
`CLAUDE_CONFIG_DIR`). `bun run test` before review readiness unless resource contention makes it
impractical, recorded under Verification.


## Audit disposition (round 1)

Independent audit (`mistral/deepseek-v4-1-flash-1017`, read-only; the first two routes failed with HTTP 401 and
stalled): NEAR-PASS, 1 blocker, 4 majors, 6 minors.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Disconnect admin-gated; can stay pending with no retry owner | Partly rebutted, partly folded. Revocation stays ungated, like `PUT /api/telemetry` declines and `ocx telemetry disable`: the human-only rule covers giving consent, and gating withdrawal would make it harder to leave. Folded: an explicit `deletion_pending` status with a named retry owner, the CLI deleting directly when the proxy is stopped, the loop starting whenever a profile file exists, deletion never gated on telemetry, and tests for all of these. |
| 2 | Create rate limit shares the anonymous IP-hash key | Folded: domain-separated hash input and a separate table, so no stored value is joinable. |
| 3 | Rank semantics undefined | Folded: rank contract in 020 (`RANK()`, handle display order, `rank: null`, `of`). |
| 4 | Plaintext secret, no rotation | Folded as documentation: disconnect + reconnect is the rotation path; the file is uninstall-owned and kept out of exports and backups (checked in B). |
| 5 | Public profile indexability/fields | Folded: `x-robots-tag: noindex`, a fixed by-handle field list, no per-profile static page. |
| 6 | Loop does not start under env opt-out | Folded with 1. |
| 7 | CLI usage strings | Folded: `USAGE` and the registry usage change in the same commit. |
| 8 | Dedup SQL unspecified | Folded: exact pattern written in 020. |
| 9 | GUI rendering/link encoding | Folded in 030. |
| 10 | README wording ambiguity | Folded in 050. |
| 11 | `--no-verify` unnecessary | Rebutted: the owner's merge rules require pushing with `--no-verify` and disclosing it. |
