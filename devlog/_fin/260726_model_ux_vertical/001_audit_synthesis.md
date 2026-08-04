# 001 — A-phase audit synthesis (WP0)

Reviewer: independent explorer subagent (`gpt-5.6-terra`, high effort), read-only,
audited `000`–`040` against the tree at `dda9fa38`. Final line: `VERDICT: FAIL`,
9 blockers. This document records the root cause of each, the accept/rebut decision,
and where the fix landed (REVIEW-SYNTHESIS-01).

Round 1 outcome: FAIL → plan amended → re-audit.

## Blocker dispositions

### 1. High — `POST /api/grok/apply` is a web-reachable TOML write. ACCEPTED.

Root cause: `030` framed the guard as "no new writer" while adding an HTTP route that
reaches `injectGrokConfig` → `atomicWriteFile(configPath, …)` (`src/grok/inject.ts:238`).
That is a real capability change, and the proposed guard test — a text scan for
`writeFileSync`/`atomicWriteFile` in the route file — would have passed while the
capability existed. A guard that cannot fail is not a guard.

Decision: keep the route (a switch the user must go to a terminal to apply is a broken
affordance), but state the boundary honestly and defend it:

- The rule becomes: **no new code path may write `~/.grok/config.toml`;
  `injectGrokConfig` remains the single writer, and the HTTP route may only ask it to
  run with the current config.**
- Threat model written into `030`: the route is behind the management auth + origin
  boundary (`src/server/index.ts:344-348`, `src/server/management-api.ts:82-92`), it
  accepts **no body**, and it takes **no caller-supplied path, host, port, or model
  list** — every input comes from the persisted config and the runtime port record. The
  worst an authenticated caller can do is re-run the sync the CLI already runs on every
  `ocx start`/`ensure`/`restart`.
- Concurrency: applies are serialized with a module-level promise chain so two clicks
  cannot interleave two read-modify-write cycles on the same file.
- The guard test is rewritten to assert the single-writer rule mechanically: `rg` over
  `src/` proves `config.toml` is written only from `src/grok/inject.ts`, and the route
  test proves the HTTP path reaches the guarded writer (temp `GROK_HOME`, observed
  `skippedReason`), rather than proving a string is absent.

### 2. High — the apply route would use the wrong host/port. ACCEPTED.

Root cause: `030` copied `Number(url.port) || config.port` from the Desktop apply route
and passed `config.hostname`. `url` is built from the request
(`src/server/index.ts:302`), so a proxied or renamed authority can misreport it, and
`config.hostname` is exactly the value `src/grok/sync.ts:24` warns may have drifted
from the bound host — which is why `ocx ensure` passes `live.hostname`
(`src/cli/index.ts:320-324`).

Decision: the authoritative source already exists and neither the reviewer nor the plan
named it: `writeRuntimePort({ pid, port, hostname })` is written by the running proxy at
startup (`src/cli/index.ts:200`) and read back by `readRuntimePort(expectedPid)`
(`src/config.ts:1000`). The route uses `readRuntimePort(process.pid)` and falls back to
`config` only when that record is missing. This is stronger than the reviewer's
suggestion (threading it through `ManagementContext`) because it needs no plumbing
through five call sites and it is the same record the liveness probe trusts.
A regression test drives a runtime-port record whose hostname is non-loopback and
asserts the sync refuses with `skippedReason: "non-loopback"`.

### 3. High — aliases cannot be reconstructed, and exclusion renumbers them. ACCEPTED.

Root cause: `buildGrokManagedBlock` assigns aliases with a collision counter over the
list it is given, plus reservations for user-owned tables (`src/grok/inject.ts:130-165`).
Two facts follow that `030`/`040` missed: the GUI cannot compute an alias from
`{id, contextWindow, native}`, and excluding an earlier colliding model shifts the
suffix of a later one — a user's `ocx-kimi-k3-2` can silently become `ocx-kimi-k3`.

Decision, two parts:

- **Display:** the page shows the alias from `readGrokStatus()` (what is actually in the
  file today) for registered models, and `—` for models not in the fence. It never
  guesses. This is what `040` half-promised; now it is explicit.
- **Stability:** `buildGrokManagedBlock` gains no new behaviour, but `syncGrokConfig`
  allocates aliases against the **unfiltered** list and then drops excluded entries, so
  a model's alias no longer depends on which other models are switched off. Concretely,
  `filterGrokSelectedModels` moves from "filter the ids" to "filter after alias
  allocation": the sync passes the full list plus an `excluded` set into the builder,
  which skips emitting excluded tables while still consuming their alias slots. Tests
  cover colliding sanitized ids (`kimi/k3` vs `kimi-k3`) and user-reserved aliases.

### 4. High — `readCollapsedGrokGroups` is a phantom. ACCEPTED.

Root cause: `040` used a helper no document defines. Fix: WP1's
`claude-desktop-collapse.ts` is generalized to `gui/src/pages/collapse-store.ts` — a
keyed collapse store, `makeCollapseStore(key)`, used by both pages, so there is exactly
one implementation, one malformed-storage fallback, and one test file. It takes no
`defaults` argument: `read()` returns `null` for "no stored preference" and each caller
applies its own data-driven default (Desktop: `defaultCollapsedFamilies`; Grok: both
groups open). `010` and `040` are amended to import it.

### 5. Medium — missing `001` research doc; goalplan disagrees with the plan. ACCEPTED.

This document is the `001`. The goalplan task text naming `claude-desktop-lane.ts` as
the helper home is corrected to `collapse-store.ts` in the same amendment.

### 6. Medium — stale citations and baseline SHA. ACCEPTED.

Verified each correction against the tree: `claude-lanes` is `ClaudeDesktop.tsx:321`,
the render-only comment is `:115-119`, `destinations` is `:109`, the Models group head
runs `:614-635`. Baseline recorded as `b4485706` was correct at authoring time; the
plan now records `dda9fa38` (the WP0 docs commit) as the implementation baseline.
Corrected in `000`, `010`, `020`.

### 7. Medium — source-shape tests where behaviour is testable. ACCEPTED.

The repo already mounts React with Happy DOM (`gui/tests/subagents-busy-race.test.tsx`),
so a source-string assertion for interactive behaviour is a choice, not a constraint.
Amended: WP1 and WP2 each get a mounted test — collapsed-family drop still moves a
model; collapse → pick a move destination → reopen preserves the pending destination;
the header count stays unfiltered while searching. WP4 gets a mounted test for the
absent-Grok switch state and the skipped-apply message. Source-shape assertions remain
only for structural invariants (which class names exist, which endpoints are called).

### 8. Medium — disclosure defaults contradict the criterion. PARTIALLY ACCEPTED.

Accepted: hard-coding Fable/Sonnet/Haiku as collapsed is wrong, because any model can
be assigned to any family (`ClaudeDesktop.tsx:153-157`). The default becomes
data-driven: **a family starts open when it has at least one model, collapsed when
empty**, with Opus first by position. On the screenshot's shape (23 in Opus, 0
elsewhere) this produces the same result the fixed list would have, but it stays correct
once the user fills Sonnet.

Accepted: the effort badge returns to the collapsed summary as a compact chip — it
informs the default choice, so hiding it defeats the purpose of the summary.

Rebutted: keeping the default row open is not a contradiction to fix by closing it; it
is the discoverability rule in `ux-states.md` §5 applied deliberately — the row a user
came to change should not require a second click. `000`'s wording is amended from "rows
collapsed by default" to "rows collapsed by default except the family's resolved
default", so the criterion and the implementation say the same thing.

### 9. Medium — `<h3>` inside `<button>`. ACCEPTED.

Invalid nesting (a heading is not phrasing content). Amended to
`<h3><button aria-expanded=…>…</button></h3>`, which keeps the heading in the a11y tree
and gives the button the family name as its accessible name.

## Rejected in part / notes carried forward

- The reviewer's suggestion to thread listener host/port through `ManagementContext` was
  narrowed to `readRuntimePort(process.pid)` (blocker 2) — same guarantee, no plumbing.
- Reviewer confirmed: `IconChevron` takes SVG props, `CatalogModel.alias` and
  `nativeOpenAiContextWindow` exist, `jsonResponse`/`saveConfig`/`config`/`url` are in
  handler scope, auth+CORS wrap the new routes, `models.search`/`models.showMore`/
  `common.retry` exist in all six locales, and dropping the `.claude-lanes` media
  queries is safe. `Switch` accepts only `on`/`onClick`/`disabled`/`label`, so WP4 must
  pass a translated `label`.
