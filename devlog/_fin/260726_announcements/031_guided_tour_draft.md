# 031 — DRAFT: game-style guided tour (deferred to a later release)

> **Status: DRAFT, NOT SCHEDULED.** Recorded at the maintainer's request so the
> feasibility work is not lost. Target: the release AFTER next, not this unit.
> WP-D (`030_onboarding_steps.md`) ships the plain stepper first; this document is
> the upgrade path from stepper to tour.

## The ask

A first-run experience closer to a game's opening tutorial: advancing a step also
switches the dashboard tab, highlights what the user should look at, and lets them
act inside the real UI rather than reading a description of it.

## Feasibility — verified against the code, not assumed

Two capabilities the tour needs already exist:

| Need | Existing mechanism | Location |
|---|---|---|
| Drive tab changes from outside the sidebar | `navigateToPage(id)` sets the hash AND React state | `gui/src/use-app-route-state.ts:55-58` |
| Address a nav entry to highlight it | every nav button carries `data-page={id}` | `gui/src/App.tsx:242` |
| Deep-link a step | hash routing with deliberate-vs-passive navigation already separated | `gui/src/hash-routing.ts` |

So "next step also opens the Providers tab and points at it" needs no new
navigation plumbing — it reuses the exact path a sidebar click takes.

## Cost is NOT uniform across the idea

This is the part worth recording, because the request reads as one feature and is
really five with an order-of-magnitude spread:

| Capability | Cost | Why |
|---|---|---|
| Step through 1–5 in a modal | low | one state value, existing modal shell |
| Switch tabs on advance | low | one `navigateToPage` call per step |
| Highlight a SIDEBAR entry | medium | `[data-page="..."]` exists; needs an overlay + scroll-into-view |
| Highlight an element INSIDE a page | high | no anchors exist; every target page needs a stable hook added |
| Gate advance on real completion | high | per-step completion detection wired into each page's data |

The first three are a contained increment on top of WP-D. The last two are where
the work multiplies, because they push tour concerns into pages that currently
know nothing about onboarding.

## Design position: guide, do not trap

A game tutorial can block progress because failure costs nothing. Here, step 2 is
"add a provider", which means a real API key. A user without one at that moment
would be stuck inside a modal they cannot satisfy — and this audience is largely
developers already running Codex CLI, for whom forced hand-holding reads as
disrespect rather than help.

Proposed shape: **quest log, not forced tutorial.**

- advancing switches the tab and highlights the target, so the user sees where the
  action lives;
- completion is DETECTED and shown as a check, giving the sense of progress;
- but advance is never blocked on it, and skip is always available.

This keeps the game feel (visible objectives, visible progress) without the
failure mode.

## Known hazard: the tour steals the user's place

Driving tab changes means the user loses whatever they were looking at. The tour
must capture the page it started on and restore it on skip or finish. Without
that, closing the tour leaves the user somewhere they did not choose — a small
detail that reads as the whole feature being broken.

## Decisions taken in Interview (2026-07-26)

| Question | Answer | Consequence |
|---|---|---|
| Stack | **Build it ourselves.** No `react-joyride`/`driver.js`. | Keeps GUI runtime deps at three (`react`, `react-dom`, `@tanstack/react-virtual`) and avoids the dependency-installation security review at `MAINTAINERS.md:22`. We own the geometry: anchor math, scroll-into-view, resize/reflow, focus. |
| Highlight scope | **In-page elements, not just sidebar entries.** | The expensive branch of the cost table above. Every target page needs a stable, documented anchor; the tour cannot rely on CSS selectors that a refactor silently breaks. |
| Progression | **Not completion-gated.** Skip per step, plus a skip-the-whole-tour button. | Confirms the "guide, do not trap" position: a user without an API key at step 2 is never stranded. Full-skip must be reachable from every step, including the first. |
| Audience | **First-time users only** (`baseline.firstRun === true`). | The tour never fires for an existing installation. It REPLACES the plain stepper for brand-new installs in a later release rather than layering on top of it. |

### What "first-time users only" settles — and what it costs

This resolves H1 below: there is no longer an "upgrade path from stepper to
tour" that needs a state in which to run, because the tour deliberately does not
reach users who already have an installation. The two flows are alternatives
selected by install age, not successive experiences.

The cost is that the expensive branch — per-page anchors, live geometry,
virtualizer integration — now serves a session that happens **once per machine,
is fully skippable, and can never be replayed by an existing user**. That is not
an argument against building it, but it is the trade the next design pass must
accept explicitly rather than discover late.

### How to actually see it during development

A first-run-only feature is normally hostile to review: the reviewer's own
machine has a config, so the flow they are asked to approve never appears for
them. That is not the case here — `src/config.ts:316` resolves the config
directory from `OPENCODEX_HOME`, so a throwaway home reproduces a genuine first
run on demand:

```
OPENCODEX_HOME=$(mktemp -d) ocx start
```

Worth writing down now, because H3 already establishes that the highlight
geometry cannot be asserted in happy-dom. Manual visual verification is therefore
the acceptance path for this feature, and this command is what makes that path
available to anyone rather than only to a maintainer willing to move their real
config aside.

### What the in-page choice commits us to

Named here because it is the difference between a two-day feature and a
two-week one:

- an **anchor registry** — a stable id per highlightable target, owned somewhere,
  rather than ad-hoc query selectors;
- **existence handling** — a step whose target is not mounted (wrong page, list
  not yet loaded, virtualized row off-screen) must degrade to the page-level
  highlight instead of pointing at nothing;
- **geometry upkeep** — reposition on scroll, resize and layout shift, because the
  overlay is not part of normal flow.

### Open questions still outstanding

1. Which specific in-page targets get anchors, and who owns adding them — the
   tour, or each page?
2. Completion detection: with no gating, is a per-step "done" check still worth
   showing, and can it be read from data the dashboard already fetches?

## Contradiction scan — 2026-07-26 (3 read-only lenses)

Run against the decisions above before any code exists. Nine high-severity
conflicts; the ones that change the shape of the feature are recorded here so the
release that builds this starts from them instead of rediscovering them.

### H1 — the tour can never fire for anyone who saw the stepper

`031` says the tour reuses `onboarding.lastStep` and must not invent its own
state. But `030` makes onboarding fire only while no `completedAt`/`skippedAt`
exists. Every user who completes or skips the shipped stepper is therefore
permanently ineligible for the tour that replaces it — the "upgrade path from
stepper to tour" has no state in which it can run.

Unresolved. The next design pass must decide whether the tour is a second entity
with its own eligibility, or whether shipping it invalidates the stepper's
terminal stamps.

### H2 — one overlay cannot spotlight both a sidebar entry and page content

`.sidebar` is a stacking context at `z-index: var(--z-overlay)` = 30
(`gui/src/styles.css:219-226`), while a `document.body` portal sits at
`--z-modal` = 50 (`:112-115`). A nav button inside the sidebar can never paint
above a z-50 scrim regardless of its own z-index. The same
`backdrop-filter`/`transform` containing-block trap that invalidated a fix
earlier in this session applies again.

Consequence: sidebar highlighting and in-page highlighting are two mechanisms,
not one parameterised one.

### H3 — the geometry claim is unverifiable by our only test harness

happy-dom (`gui/package.json`) returns `getBoundingClientRect()` of all zeros for
a styled element; existing tests already stub the prototype
(`gui/tests/logs-auto-refresh.test.tsx:48-58`). `IntersectionObserver` and
`ResizeObserver` exist but observe a zero-geometry layout.

So "the spotlight lands on the right element at the right size" — the defining
success property of an in-page highlight — cannot be asserted by any gate in
`040_final_gates.md`. Either the feature accepts manual visual verification as its
acceptance path, or it needs a real-browser harness this repo does not have.

### H4 — virtualized rows have no node to anchor to

Logs and Debug render through `useVirtualizer` (`gui/src/pages/Logs.tsx:305-311`).
A step targeting a row outside the virtual window has nothing to measure, so the
tour would have to drive `scrollToIndex` — pushing tour concerns into the
virtualizer.

### H5 — the router has no address for an in-page target

`navigateToPage(id: Page)` addresses pages only. Sub-page position lives in
component-local `useState` (`Logs.tsx:260`, `Claude.tsx:9`,
`ProviderDetails.tsx:87`) that no external caller can set. An in-page target
needs a `(page, region, element)` address; the repo has only the first term.

### H6 — "skip this step" and "skip the tour" collapse to one field

The user asked for both. `030`'s substrate has `lastStep` (a position) and
`skippedAt` (a terminal stamp), so declining step 2 and passing step 2 are
indistinguishable once persisted — which also destroys the "gentle re-offer"
signal `030` says skipping exists to preserve.

### H7 — no way to know whether the tour worked

There is no telemetry sink anywhere in the product, and `scripts/privacy-scan.ts`
is structured to keep it that way. `completedAt`/`skippedAt` never leave the
installation. With an instant full-skip and no gating, a tour everyone dismisses
in one second is indistinguishable from a successful one.

This is not an argument for adding analytics — it is an argument for deciding, up
front, that this feature ships on judgment rather than measurement, and saying so.

### Medium findings, recorded without expansion

- Focus ownership collides with the mobile drawer's `inert` + focus-restore
  (`gui/src/App.tsx:146-155`, `:211-215`); a body-portalled tour panel is not
  inert while `main` is.
- Every tour string multiplies by six locales before lint and tests pass; the
  i18n surface scales with the number of highlighted targets.
- Measure-then-`setState` in a layout effect is the natural spotlight
  implementation and is exactly what the react-doctor gate rejects.
- "Step" is already taken twice in the surface the tour targets:
  `AddCodexAccountStep` and the provider modal's own `setupStep1/2/3`.
- `select-position.ts` is a weaker reuse candidate than assumed: it positions a
  fixed-size menu from a static trigger and relies on portalling, not on tracking
  an arbitrary target across scroll containers and page transitions.
- Restoring the user's page fights the hash for ownership of "where the user is",
  and restoring via `navigateToPage` pushes another history entry rather than
  undoing one.

### Fixed during this scan

`030`'s test list still encoded the provider-count trigger its own audit had
killed. Corrected to `baseline.firstRun`.

## Rescan after "first-time users only" — 2026-07-26

H1 is **partially** resolved, and the rescan surfaced a defect that would have
shipped a feature with no audience at all.

### R1 (HIGH, blocks implementation) — `firstRun` does not mean "new user"

`030` defines `firstRun` as "the config file was absent at baseline-stamp time",
and `010` stamps the baseline on the first `GET /api/announcements` — that is, on
the first dashboard visit. But the config file is written by several paths that
normally run BEFORE anyone opens the dashboard, each verified in source:

| Path | Writes config |
|---|---|
| `ocx init` | `src/cli/init.ts:166` |
| proxy startup seeding/migration | `src/server/index.ts:248`, `:265` |
| port-fallback persistence | `src/cli/index.ts:133` |
| OAuth login | `src/oauth/login-cli.ts:125` |

So `firstRun` actually measures *whether the user opened the dashboard before
touching the CLI* — not whether they are new. A brand-new user following the
documented `ocx init` → `ocx login` path stamps `firstRun: false` and never sees
the tour.

This was survivable while `firstRun` was one of two conditions. As the SOLE gate
it empties the feature's audience, and the failure is invisible: the tour ships,
nothing errors, and nobody ever sees it.

**The next design pass must replace the signal, not tune it.** Candidates worth
evaluating: stamp the baseline at first config CREATION rather than first
dashboard read; or record "has this installation ever completed a meaningful
action" (a provider the user actually configured, distinct from the seeded
`openai` default) instead of inferring newness from file mtime semantics.

### R2 (HIGH) — stepper and tour still share one trigger with no discriminator

A user who installs the *stepper* release fresh gets `firstRun: true` AND a
terminal `completedAt`. When the tour ships, a literal first-run-only rule says
show it; the inherited stepper rule says never again. The substrate cannot
express "saw the stepper, has not seen the tour", so H1's residue moved rather
than disappeared.

That cohort is precisely the population that exists when the tour launches.

### R3 (MEDIUM) — the gate list can only verify the tour stays invisible

`040`'s three manual checks are all negative ("announcements still empty",
"onboarding does not fire for an upgrader"). Nothing makes the tour APPEAR. With
H3 establishing that geometry cannot be asserted in happy-dom, the only
acceptance path is visual — so `040` needs a positive procedure, using the
`OPENCODEX_HOME` throwaway root documented above.

### R4 (MEDIUM) — the investment now serves the narrowest possible cohort

The expensive branch was justified as "the upgrade path from stepper to tour",
which first-run-only forecloses. What remains is a one-time, instantly
skippable, unmeasurable session for new installs only. Not a veto — but
`000_plan.md`'s own UX-LAZY-01 cost test demands this be accepted deliberately.

### R5 (MEDIUM) — an abandoned tour can hold announcements forever

Announcements are suppressed while onboarding is pending. If a user closes the
window mid-tour, no terminal stamp is written and the badge stays hidden
permanently — for the only cohort that can ever be in that state. `040` checks
the opposite case only.

## Decisions to close the rescan — 2026-07-26

### First attempt (D1-D5) — DEFEATED, kept for the record

I proposed five decisions and had them attacked by a fourth lens. All five fell.
The reasoning is preserved because the failures are more instructive than the
proposals:

| # | Proposal | Why it fell |
|---|---|---|
| D1 | "New install = exactly the seeded canonical `openai` provider" | `ocx init` REPLACES `providers` wholesale (`src/cli/init.ts:159-164`), and its featured first option is that same canonical openai row — so the documented onboarding path lands in the "new" bucket forever. Meanwhile ChatGPT pool accounts persist to `codex-accounts.json` (`src/codex/account-store.ts:17`), not `config.providers`, so a heavily-configured user still reads as new. Legacy tier migration (`src/providers/openai-tiers.ts`) can also rebuild an upgrader's row byte-identical to the seed. |
| D2 | Split into `onboarding.stepper` / `onboarding.tour` | No migration was specified for configs the stepper release already wrote in the flat shape, so every graduate would see the stepper again. |
| D3 | Suppress announcements only "in this session" | There is no session identity in a config-backed HTTP route, so the priority rule would silently move client-side, out of the substrate that exists to enforce it. |
| D4 | `OPENCODEX_HOME=$(mktemp -d) ocx start` as a safe first-run harness | `OPENCODEX_HOME` scopes only the ocx config dir. The same `ocx start` still rewrites the real `~/.codex/config.toml`, the shell hook, system env and `~/.grok/config.toml`, and fights the real proxy for port 10100. "Real config untouched" was false. |
| D5 | Ship sidebar-only highlighting first | Reverses an explicit user answer without asking, and H2 already established the two highlight tiers are separate mechanisms — so the cost is duplicated later, not deferred. |

### The pattern behind all five failures

Every proposal tried to **infer** whether a user is new from state kept for some
other purpose — file timing, provider shape, session identity. Each inference had
a path that falsified it, and each fix would have needed another inference.

That is the actual finding: newness is not derivable from this codebase's
existing state. It has to be **recorded deliberately, once, by the code that
first has the answer**.

### D1′ — record newness at config creation, explicitly

`saveConfig` (`src/config.ts:845-857`) is the single choke point through which
every config write passes, and it can see whether the file already existed. The
first write stamps an explicit marker:

```ts
  /** Written once, by the first saveConfig that creates the file. Never inferred. */
  install?: { createdAt: string; createdByVersion: string };
```

Onboarding eligibility then reads a fact rather than a proxy: the marker is
absent on every pre-existing installation (they were created before the field
existed), and present with a known version on every new one. No path through
`ocx init`, tier migration, pool accounts or port fallback can forge it, because
none of them can make an existing file not exist.

The earlier objection to this candidate — "startup seeding also creates the
file" — is now handled honestly: an installation created by startup seeding IS
new. The marker records when the installation began, which is true regardless of
which command began it. What it must NOT do is claim to know whether the user has
done anything yet; that is a separate question the tour does not need to ask.

### D2′ — the tour is eligible only for installs created after it shipped

`install.createdByVersion` makes R2 answerable without a discriminator field:
the tour fires when the installation was created by a version at or after the
tour's own release. A stepper graduate was created earlier and is never eligible,
which is the intended "first-time users only" semantics, stated positively.

The stepper keeps its existing flat record. No migration is needed because no
existing key changes meaning.

### D3′ — suppression is released by any terminal stamp, and abandonment writes one

Rather than invent session identity, the client writes `skippedAt` when the user
navigates away mid-tour (`beforeunload`, or the next load observing an
unterminated tour). Announcements are suppressed only while a tour has no
terminal stamp, which the substrate CAN express.

### D4′ — the first-run harness needs full isolation, and that needs verifying

`OPENCODEX_HOME` alone is not enough. A usable procedure must also redirect
`CODEX_HOME`, avoid the shell hook and system env, use a non-default port, and
leave `~/.grok` alone. Whether the CLI supports all of that in one invocation is
UNVERIFIED — the implementation pass must confirm it before `040` promises it.

### D5′ — in-page highlighting stays, as the user decided

Withdrawn. The scope reduction was mine, not the user's, and H2 shows it would
duplicate rather than defer the cost. In-page highlighting remains the target;
the cost question from R4 is a real one but belongs to the user, not to me.

### D2 — the tour gets its own eligibility key

Closes R2. `031`'s original "do not invent tour-specific state" rule was written
before the tour became a first-run-only alternative to the stepper, and taken
literally it makes the two indistinguishable. The substrate gains a discriminator:

```ts
onboarding?: {
  stepper?:  { completedAt?: string; skippedAt?: string; lastStep?: number };
  tour?:     { completedAt?: string; skippedAt?: string; lastStep?: number };
};
```

Two records of the same shape, not two schemas. The prohibition it relaxes was
aimed at preventing a parallel STORE, and this stays in the one store.

### D3 — abandonment releases announcements after the first reload

Closes R5. A tour that is never finished must not hold announcements forever.
Rule: announcements are suppressed only while a tour is **in flight in this
session**. On a fresh page load with a `lastStep` recorded but no terminal stamp,
the tour does not auto-resume and announcements are released; the tour remains
available from a manual entry point.

Closing the window is a decision, and treating it as one is more honest than
trapping the user in a flow they walked away from.

### D4 — `040` gains a positive verification procedure

Closes R3. Since H3 makes the geometry unassertable in happy-dom, the gate list
must contain a way to make the tour APPEAR, not only checks that it stays hidden:

```
OPENCODEX_HOME=$(mktemp -d) ocx start   # genuine first run, real config untouched
```

### D5 — the cost question is answered by scope, not by argument

R4 observed that the expensive branch now serves the narrowest cohort. Rather
than defend the cost, the first tour release ships **sidebar-level highlighting
only** — the cheap tier that needs no per-page anchors, no virtualizer
integration, and no in-page geometry.

In-page anchors stay in this document as a follow-up, to be added for the
specific steps that measurably need them once the tour exists and can be watched.
This keeps the user's "highlight in-page elements" decision as the destination
while refusing to pay for all of it before anything has been observed.

## Dependency

Requires WP-B's state substrate (baseline + `onboarding.lastStep`) and WP-D's
stepper. Building the tour first would mean inventing tour-specific state that the
substrate then has to absorb.
