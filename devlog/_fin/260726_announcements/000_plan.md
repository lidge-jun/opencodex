# 000 — 260726-announcements: Plan

## Objective

Give opencodex a way to tell a user that something changed — without building the
notification treadmill that makes users learn to dismiss without reading.

Two rules, set by the maintainer, shape everything below:

1. **Opt-in per announcement, not per release.** A release does not generate an
   announcement. Someone decides an individual item is worth interrupting for.
2. **No backfill.** A user arriving from an older version must not receive a
   backlog of everything they missed.

The onboarding flow (a 1–5 step popup) follows in a later work-phase and sits on
the same state substrate, because "have they seen this" and "which of several
things do we show first" are the same two problems.

## Evidence base — what exists, and the one thing that does not

| Capability | Where | Status |
|---|---|---|
| Update detection | `src/update/job.ts` `checkForUpdate()`, `GET /api/update/check` | exists |
| Accessible modal pattern | `gui/src/components/OAuthTosWarningModal.tsx` and 2 siblings | exists |
| Server-persisted preference | `config.claudeCode.desktopAutoApply` (`src/types.ts:427`) | exists |
| Settings read/write route | `GET`/`PUT /api/settings` (`config-routes.ts:78`, `:183`) | exists |
| GUI client-side preference | `localStorage` — one precedent, the theme (`App.tsx:72`, `:102`) | exists |
| "Already seen" / dismissed state | — | **absent repo-wide** |
| Install timestamp or config schema version | `rg` over `src/types.ts` finds only per-API-key `createdAt` | **absent** |

That last row is the constraint the whole design turns on, and it is why the
no-backfill rule needs care rather than a one-line check.

## Design decision 1 — the baseline problem

"Do not show announcements from before the user arrived" needs an arrival time,
and we have none. Three candidate baselines, with why two fail:

| Candidate | Verdict |
|---|---|
| Config file mtime | REJECTED. Rewritten on every provider edit, so it drifts forward and would suppress legitimately new announcements. |
| Installed version at first run | REJECTED alone. An existing user upgrading from 2.7.x has no recorded prior version, so their first observed version IS the new one — indistinguishable from a fresh install. |
| **First-observation stamp, written once** | ADOPTED. On the first run that carries this feature, record the current version and timestamp, then show only announcements declared AFTER that stamp. |

The adopted rule has one deliberate consequence worth stating plainly: the very
first release that ships this system shows **nothing** to anyone. Every existing
user gets their baseline written silently, and announcements begin with the next
declared item. That is the correct behaviour — it is exactly the "backlog dump"
the maintainer ruled out — but it must be written down, or a later reader will
report the silence as a bug.

### Boundary cases the implementation must satisfy

| Case | Expected |
|---|---|
| Fresh install, no announcements yet | baseline written, nothing shown |
| Existing user upgrading into this feature | baseline written, **no backlog**, nothing shown |
| Announcement declared after the baseline | shown once |
| Same announcement after dismissal | never shown again |
| Announcement declared before the baseline | never shown, even after later upgrades |
| Clock skew / baseline in the future | fail closed — show nothing rather than everything |

## Design decision 2 — where the state lives

Server config, not `localStorage`.

`localStorage` is per-browser: the same user on a second browser, or after
clearing site data, would see every announcement again — a backlog dump through
the side door, defeating rule 2. Announcement state is a property of the
installation, not of a browser profile. It also has to be readable by any future
non-GUI surface (`ocx status`), which a browser store cannot serve.

Cost accepted: a config write on dismissal, and a new field in `OcxConfig`. The
theme precedent stays in `localStorage` because it genuinely IS per-device.

## Design decision 3 — declaration lives in code, not in a release artifact

Announcements are declared in a typed catalog module in the repository, each with
an explicit id and a declaration timestamp. Not derived from release notes, not
from the changelog, not from tags — all three regenerate every release, which
would resurrect rule 1's failure mode by making the default "announce".

A code catalog also means the announcement text goes through i18n (six locales,
enforced by the parity test added earlier this session) and through review.

## Design decision 4 — surface by consequence, not by importance

From `cxc-dev-uiux-design` UX-LAZY-01: every surface is a decision cost, so the
surface follows what the user must DO.

| Announcement kind | Surface | Why |
|---|---|---|
| Requires a user decision (opt in to a new integration) | modal | there is a real fork; blocking is honest |
| Informational ("X now supports Y") | sidebar badge to a detail panel | no fork, so no interruption |
| Actionable-but-conditional (Grok detected, not wired) | inline on the owning page | only meaningful in context, and self-clearing |

The default is the middle row. A modal must justify itself against "is there a
choice only the user can make?" — the same test that kept the Grok tab read-only
in the previous unit.

## Loop-spec

- Loop archetype: verifier-defined for the baseline/state rules (pass/fail), judged
  for the surface treatment.
- Write scope: `src/`, `gui/src/`, `gui/tests/`, `tests/`,
  `devlog/_plan/260726_announcements/`.
- Out of scope: a per-command CLI banner (rejected: it pollutes scriptable output;
  `ocx status` is the ceiling if it is ever wanted), security-boundary PR merges,
  release publication, version bumps, `main`/`preview` promotion.
- Bounds: local gates only. No push without explicit approval (LOOP-GIT-01).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP-A | `000` (this doc) | Design lock | — |
| WP-B | `010_announcement_core.md` | Catalog, baseline, seen/dismiss state, API | — |
| WP-C | `020_announcement_surface.md` | GUI badge/panel/modal by kind | WP-B |
| WP-D | `030_onboarding_steps.md` | 1–5 step onboarding on the same substrate | WP-B |
| — | `031_guided_tour_draft.md` | Game-style guided tour — DRAFT, deferred to a later release | WP-D |
| WP-E | `040_final_gates.md` | Full gates and close-out | WP-B–WP-D |

WP-D is deliberately last among the feature phases: onboarding content is a
product judgment, and building the substrate first means that judgment is the only
open question when we get there.

## Accept criteria

- `c-design` — schema, baseline rule and storage location are each decided with
  the rejected alternatives recorded.
- `c-nobackfill` — the six boundary cases above are pinned by tests, especially
  "existing user upgrading in sees nothing".
- `c-surface` — each announcement kind renders on its assigned surface, dismissal
  persists, and all six locales carry the keys.
- `c-gates` — `bun run typecheck`, `bun run test`, `gui bun run test`,
  `bun run lint:gui`, `bun run privacy:scan`, zero new failures.
