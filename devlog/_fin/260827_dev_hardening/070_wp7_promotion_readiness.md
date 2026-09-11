# wp7 — promotion readiness at `2a72cc017`

This is the closing record for the 260827 dev hardening unit. It states what is proven
about the current `dev` head, what is deliberately not on it, and what a promoter still
has to do. It is not an approval to promote.

## The head

`dev` = `2a72cc0173af36d4b8172b70ba0a3384db9e6047`, 283 commits ahead of `main`
(`ec51e42d7`, v2.33.0). `package.json` reads `2.34.0`, so the version line is ahead of the
published channel rather than behind it — which is the whole subject of wp2 and is now
guarded by `tests/release-version-line.test.ts`.

## What this unit changed

| Work phase | PR | Merged as | What it closed |
| --- | --- | --- | --- |
| wp1 | #2738 | `5dfee1a05` | inventory and remediation roadmap |
| wp2 | #2739 | `ca3b379e1` | dev carried a version behind its own releases |
| wp2b | #2743 | `a57b9620a` | the version guard could go inert without `fetch-tags` |
| wp3 | #2745 | **not merged** | credential identity on OAuth 429 rotation |
| wp4 | #2746 | `802f04adc` | locale pages that contradicted the code |
| wp5 | #2749 | `5000321e6` | `doctor:gui` failed on dev, so prepush was routinely bypassed |
| wp6 | #2751 | `2a72cc017` | two invariants AGENTS.md claimed were enforced, and were not |

## Proven at this head

- Full `bun run test` on the Linux host: rc=0. The three runs during wp6 reported 15,324
  passing tests and 0 failures with no `(fail)` lines; the wp5 runs reported 15,318.
- Cross-platform CI green on each merged head, covering Linux, Windows, and macOS. The
  macOS leg is the slow one at roughly 9-11 minutes and is always last to report.
- `bun x tsc --noEmit`, `bun run lint:gui`, and `bun run doctor:gui` all exit 0 locally on
  `dev` — the last of those for the first time this unit, which is what wp5 was for.

## Not on this head, on purpose

**PR #2745 (wp3) is open and must stay open.** It changes credential identity handling on
OAuth 429 rotation, which `MAINTAINERS.md` puts behind explicit security review. It was not
self-merged and `maintainer-sponsored` was deliberately not applied. Anyone promoting `dev`
should know that the failover identity drift described in
`devlog/_plan/260827_dev_hardening/020_wp3_failover_identity.md` is still present on `dev`.

The review lane that examined it refuted the exploit's reachability — the missing
`continue recovery` acts as an accidental guard — so this is a correctness defect rather
than a live vulnerability. That is the reason it is a normal review queue item and not a
release blocker.

## What a promoter still has to do

Nothing here substitutes for the release procedure in `MAINTAINERS.md`. Promotion is
maintainer-controlled, and `scripts/release.ts` remains the release authority. This record
only establishes that the integration branch is in a state worth promoting from.

## What this unit did not attempt

The audit walked the core/Lab boundary, the startup activation window, repository hygiene,
the version line, locale docs, and the local gates. It did not audit provider adapters,
the GUI beyond its lint configuration, or the release workflow itself. A green suite at
this head is evidence about the code that has tests, which is the ordinary limit of this
kind of statement and worth saying out loud rather than implying otherwise.

## Addendum — `dev` has advanced past the sha above

The statement was written at `2a72cc017` and `dev` has since moved twice, so the head it
names is no longer the tip. Recorded here rather than left to rot, because a readiness
statement whose sha is stale is worse than no statement.

| Head | What it added | Proven |
| --- | --- | --- |
| `2a72cc017` | wp6 invariant locks | remote suite rc=0, 15,324 pass; CI green |
| `c457c7085` | this document (#2752) | docs only, no code differs from `2a72cc017` |
| `eeb774026` | #2750, Kiro code-mode delegation surface | remote suite rc=0, 15,334 pass; CI green |

#2750 was 14 commits behind `dev` when it came up for merge — past the 10-commit
threshold the readiness gate documents — so it was rebased onto `c457c7085` first and
re-verified at the rebased head `942193852` rather than merged on a stale base. The
rebase replayed all five commits with no conflicts. Alongside its own 68 Kiro tests, the
invariant guards and version-line locks that landed during this unit were re-run against
it (167 pass, 0 fail) to confirm the two lines of work do not interfere.

Everything the body of this document says about promotion still holds at `eeb774026`: the
version line, the gates, the invariant locks, and the deferral of #2745 are all unchanged
by the two commits above.
