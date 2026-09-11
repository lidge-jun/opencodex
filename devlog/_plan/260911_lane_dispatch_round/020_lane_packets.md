# Lane dispatch packets — 260911 (revision 3, after audit rounds 1 and 2)

Seven implementation lanes, one Codex thread each, one worktree each. Ownership is an exact path or
one named directory; `010_lane_partition.md` is the authoritative list and this file repeats each
lane's slice of it.

## Shared frame

**Repository.** Your worktree is named in your packet, already checked out on your lane branch, cut
from `origin/dev` `6d3ad12e3` (2.51.0). Work only there. Do not add, move, or remove a worktree.

**Loop.** Run `$codexclaw:cxc-loop` as HOTL for your lane: one work-phase per issue, in order. Your
goal ends when your last PR is green and reported, not when the code looks right.

**Subagents.** Unlimited `xai/grok-4.6` subagents, read-only, spawned with `spawn_agent`
(`model: "xai/grok-4.6"`). Use them to reproduce, to read the call sites you are about to change, to
find a second caller of a helper you are touching, and to review your staged diff adversarially
before you push. A finding enters your work only with an exact `path:line` anchor. Subagents never
write, commit, push, or call a mutating `gh`. Treat a `fail` verdict the way this round did: fold it
in and re-audit. This packet is at revision 3 because two audit rounds rejected revisions 1 and 2.

**MUST NOT.**

- No local product suite: no `bun test`, no `bun run test`, no `bun run test:changed`, no
  `bun run typecheck`, no `bun run build:gui`, no `bun install`. Report them as `NOT RUN`.
- No merge, no release, no force-push to a shared branch, no direct push to `dev`.
- No path outside your owned list, including paths a carried PR happens to touch. Dropping a hunk
  from a carried PR is expected; report what you dropped.
- No locale key in `gui/src/i18n/*`. If you need one, stop and report.
- No security write-up in `devlog/`; scratch space only, per `AGENTS.md`.

**MUST.**

- Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. This repository's hooks
  can start a GUI install, typecheck, and build, which the no-local-suite rule forbids.
- Push with `--no-verify`.
- Write the focused regression test `AGENTS.md` requires for a behaviour change, in the domain
  directory beside the existing tests for that subsystem, and register it in both
  `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`. You
  will not run it; hosted CI will. Those two maps are append-only and other lanes are adding to them
  too; the orchestrator resolves the conflicts at merge, so do not skip the entry.
- Fill every section of `.github/PULL_REQUEST_TEMPLATE.md` and put `Closes #<issue>` in the body. In
  **Verification**, state that the local suite, typecheck, and build were `NOT RUN` by operator
  instruction and that hosted CI on the exact pushed head is the proof.
- When you carry another author's PR, add a `Co-authored-by` trailer in a branch commit. Resolve the
  address with `gh api users/<login> --jq '.id'` and use `<id>+<login>@users.noreply.github.com`.
- Keep a devlog unit under `devlog/_plan/260911_l<N>_<slug>/`.

**Stacking.** First PR targets `dev`; the second targets the first PR's head branch, the third the
second. Retarget a child to `dev` after its parent lands. No native GitHub stacks.

**Decisions already made for you.** Both audit rounds found items where the issue left a real choice
open. Those calls are recorded in your packet in bold. Implement the recorded decision; if you think
it is wrong, report the reason and stop.

**Stop conditions.** Stop and report when the fix needs a path you do not own, when it needs a policy
no issue has fixed, when a locale key is unavoidable, or when hosted CI fails for a reason outside
your diff.

**Report format.** Per PR: number, exact head SHA, CI run id and conclusion, the issue it closes, the
co-authors credited, the hunks you dropped from a carried PR, and any decision you made. Say
`NOT RUN` for local checks.

**Decision boundary.** You do not merge, do not close another author's PR, and do not rank your lane
against another. When your last PR is green, report and stop.

## L1 — Responses pipeline and tool contract

Worktree `~/.codex/worktrees/260911-l1/opencodex`, branch `codex/260911-l1-responses-core`.

Owned: `src/server/responses/core.ts`, `src/server/responses/compact.ts`,
`src/server/responses/policy-fallback.ts`, `src/server/chat-completions.ts`,
`src/server/claude-messages.ts`, `src/server/request-log-conversation.ts`,
`src/server/responses-undeclared-tool-guard.ts`, `src/providers/opencode-go-transport.ts`,
`src/types/tools.ts`, and `docs-site/src/content/docs/reference/configuration/providers.md` (the page
#4184 already edits). You do not own `codex-ws-exchange.ts` or `codex-ws-wire.ts` (L6) or
`codex-auth-error.ts` (L3).

1. **#4172 — OpenCode Go sessionless requests omit `x-opencode-session`.** Expected behaviour is
   fixed by the issue: every request to the canonical Go destination carries the header; identity
   keeps its stable per-conversation value; no identity gets an isolated per-request value rather
   than none and rather than one shared global id; an explicit header still wins. Carry PR #4184 by
   `chilung-cgu` (open, not a draft, `CHANGES_REQUESTED`); read the review first. Most urgent item in
   the round: upstream ended the grace period on 09/06 and now errors without the header.
2. **#4176 — a routed provider prefixes a bare Codex tool with `default.`.** **Decision: normalize
   the invented prefix back at the undeclared-tool guard** — the #4181 shape, which is what the issue
   states. #4181 by `chilung-cgu` is open, not a draft, `CHANGES_REQUESTED`; #4171 by `rrmlima` is an
   open **draft** at `CHANGES_REQUESTED` and its unified-exec rewrite is out of round scope. Credit
   `rrmlima` only if you reuse code from #4171.

`core.ts` is contended by four open PRs. Keep the diff minimal; do not reformat around it.

## L2 — provider quota and registry

Worktree `~/.codex/worktrees/260911-l2/opencodex`, branch `codex/260911-l2-catalog-provider`.

Owned: `src/providers/quota.ts`, `quota-types.ts`, `quota-wire.ts`, `quota-routing-cache.ts`,
`quota-key-accounts.ts`, `account-quota-disk.ts`, `registry.ts` (all under `src/providers/`), plus
`tests/providers/provider-registry-parity.test.ts`, the oracle that locks the roster you are changing:
it asserts the two-model list at `:464` and that `glm-5.3-flash` is absent at `:508`, so the catalog
half cannot land without updating it.

1. **#4201 — BigModel Responses Coding Plan: missing quota probe and GLM-5.3-Flash catalog support**
   (reporter `bluesmilery`). **Decision: do not build on #4210.** It is an open draft by `Ingwannu`
   at `REVIEW_REQUIRED` and it also edits `docs-site/src/content/docs/guides/providers.md`, which
   belongs to L7. Implement #4201 independently; if your diff would overlap #4210's `quota.ts` hunks,
   report that overlap to the orchestrator instead of merging the two lines of work. If the fix needs
   documentation, write the wording in your report and let L7 land it.

`quota.ts` is contended by four open PRs; keep the change surgical.

## L3 — Codex account pool

Worktree `~/.codex/worktrees/260911-l3/opencodex`, branch `codex/260911-l3-account-pool`.

Owned: `src/codex/account-usability.ts`, `account-pause.ts`, `account-store.ts`,
`account-runtime-state.ts`, `plan.ts`, `plan-from-token.ts`, `warmup.ts`, `model-entitlements.ts`, `auth-api.ts`, `routing.ts`
(all under `src/codex/`), plus `src/server/responses/codex-auth-error.ts`, `src/types/config.ts`,
the single key `codexPool.excludedPlans` in
`src/config.ts`, and `docs-site/src/content/docs/guides/codex-integration.md` and its seven locale copies under
`docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/guides/codex-integration.md`.

1. **#4126 — a newly created ChatGPT Free account fails Codex warmup with HTTP 404.** Carry PR #4188
   by `chilung-cgu` (open **draft**, `REVIEW_REQUIRED`, reset by the readiness gate rather than
   rejected). It carries `src/codex/warmup.ts`, its test, and eight `codex-integration.md` pages —
   all of which you own.
2. **#4212 — an account stuck on a failed credential refresh silently drops its models.** The ask is
   attribution, not new routing. **Decision: this round covers the refusal string
   (`codex-auth-error.ts:35`), the account-health surface, and the management route
   on the Codex account surface, which is `poolAccountDto` in `src/codex/auth-api.ts:377` under
   `/api/codex-auth/accounts`. The feasibility audit found the earlier grant of
   `oauth-account-routes.ts` was the wrong route: it serves the generic `/api/oauth/accounts` and
   `src/oauth/index.ts:331` excludes ChatGPT from it. The reporter's 503 is inlined at
   `responses/core.ts:2336` and `compact.ts:383`, which L1 owns, and the model-list drop is published
   from `catalog/sync.ts:1777`. Both are out of scope: write `Refs #4212`, not `Closes`,** and record
   them as follow-ups.
3. **#4211 — keep Free-tier accounts out of pool selection.** **Decision: ship**
   **`codexPool.excludedPlans` as an array, absent by default, filtered in `getEligiblePoolAccounts`**
   **at `src/codex/routing.ts:1248` rather than in `isCodexAccountUsable`, which is where pause already
   lives, and explicit namespace selection at `auth-context.ts:922` keeps working,** so an existing install sees no
   behaviour change. Do not ship `minimumPlan`: ranking plans needs an ordering this repository does
   not have. **Decision: this round ships selection only.** If the dashboard or CLI display the issue
   also asks for needs `src/cli/account.ts`, a GUI component, or a locale key, stop and report; write
   `Refs #4211` rather than `Closes #4211` when the display half is not included.

## L4 — service, update, CLI, and connected client

Worktree `~/.codex/worktrees/260911-l4/opencodex`, branch `codex/260911-l4-service-cli`.

Owned: directories `src/update/`, `src/cli/`, `src/client/`; files `bin/ocx.mjs`, `src/cli.ts`,
`src/service.ts`, `src/config/pending-teardown.ts`, `src/lib/bun-runtime.ts`,
`src/lib/package-tree-integrity.ts`, `src/lib/process-control.ts`, `src/codex/catalog/effort.ts`,
`src/codex/cli-install-provenance.ts`, `docs-site/src/content/docs/getting-started/installation.md`.

Your stack is #4202 → #4169 → #4207. **#4204 was removed from the round** by the feasibility audit:
binding the clamp to the Desktop runtime needs `codex/runtime.ts:573`, `catalog/bundled.ts:239`, and
`catalog/sync.ts:1945`, because the catalog probes one selected runtime and no caller passes a
consumer identity. Resolving a catalog per consumer is a design decision this round does not make.

1. **#4202 — global pnpm installations cannot self-update.** Carry PR #4203 by `oliver-mee` (open
   **draft**, `CHANGES_REQUESTED`, 36 files). **Decision: the keep-set is exactly** `bin/ocx.mjs`,
   `src/cli.ts`, `src/cli/launcher-context.ts`, `src/config/pending-teardown.ts`,
   `src/lib/bun-runtime.ts`, `src/lib/package-tree-integrity.ts`, `src/service.ts`, every file under
   `src/update/`, the tests `tests/ci-workflows/install-scripts.test.ts`,
   `tests/cli/ocx-launcher-runtime.test.ts`, `tests/cli/ocx-launcher-source.test.ts`,
   `tests/update/update-badge.test.ts`, `tests/update/update-job.test.ts`,
   `tests/update/update-pnpm.test.ts`, `tests/update/update-stop-first.test.ts`, the two test-layout
   maps, and `docs-site/src/content/docs/getting-started/installation.md`. **Drop** `README.md`,
   `structure/01_runtime.md`, `structure/06_docs-and-release.md`,
   `docs-site/src/content/docs/getting-started/for-agents.md`, and
   `docs-site/src/content/docs/reference/cli/lifecycle.md`.
2. **#4169 — every stop refusal is reported as a `CODEX_HOME` ownership mismatch,** hiding
   `respawnable_service`. Carry PR #4170 by `yeongjunyoo` (open **draft**, `REVIEW_REQUIRED`); it
   touches `src/cli/index.ts` and `src/lib/process-control.ts`, both yours, plus its two tests
   `tests/lib/process-control-graceful.test.ts` and `tests/providers/xai/grok-lifecycle.test.ts`,
   which you keep.
3. **#4204 — Windows: a stale persisted CLI 0.135.0 strips max/ultra while Desktop runs 0.153.4.**
   The clamp is `src/codex/catalog/effort.ts:441`. #4178 by `luvs01` is open, not a draft, full CI
   green, and owns `src/codex/cli-install-provenance.ts`: if it lands first, rebase onto it;
   otherwise keep out of that file and say so.
4. **#4207 — the connected catalog reports success while the local Codex CLI rejects unsupported
   reasoning levels.** Same clamp as #4204, which is why both are here; client side is
   `src/client/hub-client.ts:145`, `src/client/connect.ts:542`, `src/cli/connect.ts:187`.
   **Decision: fail closed — block local readiness rather than reporting success** when the
   projection is not compatible with the local client.

## L5 — file IO and client integrations

Worktree `~/.codex/worktrees/260911-l5/opencodex`, branch `codex/260911-l5-integrations-io`.

Owned: directory `src/integrations/`; files `src/config/atomic-write.ts`,
`src/clients/config-export.ts`, `src/clients/config-export/contracts.ts`. Note `src/clients/` (plural)
is unrelated to L4's `src/client/` (singular). Open draft #3833 also edits the export-client surface;
report the overlap rather than merging the two lines of work.

1. **#4197 — the DSH integration's atomic replace changes file ownership and causes `EACCES` across
   UIDs.** **Decision: refuse the integration write when the target exists and its owner is not the
   process euid, with an explicit API error. Do not relax the `0600` hardening and do not attempt
   `fchown`.** A metadata-preserving replace can be proposed later as its own issue.
2. **#4214 — add Cline as a supported client integration.** `IntegrationClientId` is an alias of
   `ExportClientId` at `clients/config-export/contracts.ts:84`, and the writer needs `EXPORT_CLIENTS`
   from `clients/config-export.ts:1112`, which is why both are yours. **Decision: ship the CLI and
   registry path only. The dashboard tab needs a locale key this round forbids, so write `Refs #4214`**
   and leave the tab as a follow-up.

## L6 — streaming and vendor tool leakage

Worktree `~/.codex/worktrees/260911-l6/opencodex`, branch `codex/260911-l6-streaming-tools`.

Owned: `src/server/responses/codex-ws-exchange.ts`, `src/server/responses/codex-ws-wire.ts`,
directory `src/adapters/qoder/`.

1. **#4191 — a long Codex thread fails only through the proxy** (WS 1006 / prelude timeout) while the
   bypass works immediately. The timeout is `codex-ws-exchange.ts:214`. Reproduce first: establish
   what length and timing trigger it and where the prelude budget goes. **Decision: the only in-scope
   fix is to classify and report the timeout honestly, including the close code and the cause.** A
   configurable budget, an SSE fallback, or a size preflight comes back as a report, not a patch.
2. **#4190 — vendor CLI agent scaffolding leaks into routed output** for `qoder`. **Decision: fix it
   inside `src/adapters/qoder/` by sanitizing the vendor scaffolding out of routed output, failing
   closed when the shape is unrecognized.** If the fix needs `src/adapters/coding-agent/protocol.ts`,
   which no lane owns, stop and report.

## L7 — documentation

Worktree `~/.codex/worktrees/260911-l7/opencodex`, branch `codex/260911-l7-docs`.

Owned: `docs-site/src/content/docs/guides/providers.md`,
`docs-site/src/content/docs/guides/remote-hub.md`. You are the only lane that may edit
`providers.md`; L2 will send you wording rather than editing it.

1. **#4215 — state whether each provider login consumes a subscription allowance or bills per
   token.** Write the rule per authentication mode, then one explicit line per provider supporting
   both.
2. **#4200 — the remote hub guide breaks on a fresh config** (nested `ocx config set` fails when the
   parent object is absent) and has no macOS data-plane TLS example. English source first;
   translations are a follow-up.
