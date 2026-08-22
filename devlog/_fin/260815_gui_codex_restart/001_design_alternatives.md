# 001 — Design alternatives and rejected options

Survey and comparison material split out of the phase documents per LEXICO-SPLIT-01.
Phase docs carry decided invariants and executable diffs; the reasoning that produced
those decisions lives here.

## 1. Endpoint shape: new route vs flag on `/api/system/restart`

`/api/system/restart` computes its drain deadline at
`src/server/management/system-restart.ts:360` from `MEMORY_DRAIN_RESTART_MS`
(`src/lib/system-restart-contract.ts:12`, 60s) and terminates the process serving the
request. It is guarded by an HMAC capability bound to pid+port
(`src/lib/system-restart-contract.ts:44-57`) for exactly that reason.

Stopping a Codex app-server is a different action: bounded, synchronous, and it never
touches the proxy. A flag on the existing route would force one capability rule to
cover two blast radii — too strict for the new action or too loose for the old one.

**Decided:** a separate `POST /api/system/codex-restart`, plus a cheap
`GET /api/system/codex-app-server` for the state reading.

## 2. Where the staleness reading comes from

Three options were considered.

**A — reuse `GET /api/subagent-models`.** It already returns `catalogState` from the
same classifier (`src/server/management/agent-settings-routes.ts:601-605`). Rejected:
that route also assembles the full subagent model roster, so a models-page banner
would pay for work it does not use. It is also semantically owned by the subagents
page (`gui/src/pages/Subagents.tsx:116-125`).

**B — a dedicated read endpoint.** `GET /api/system/codex-app-server` returns the
classifier verdict and nothing else.

**C — poll on a timer.** Rejected outright: enumeration shells out to `ps`,
`/proc`, or PowerShell CIM. A dashboard timer that enumerates processes every few
seconds is the kind of hidden work the models workspace explicitly avoids
(`gui/src/pages/Models.tsx:325-330` gates even its catalog poll on tab activity).

**Decided:** B, fetched once on mount and on explicit refresh.

**Naming hazard found during audit:** `Models.tsx` already binds `catalogState`
(`gui/src/pages/Models.tsx:331`) to the `useDataSurface` resource state of
`/api/catalog`. It is an unrelated concept. The new value is named
`appServerState` everywhere to keep the collision from ever forming.

## 3. Sidebar layout: full-width rows vs icon satellites

The sidebar foot currently stacks full-width rows: locale, theme, stop
(`gui/src/App.tsx:250-270`). The GitHub row already demonstrates the alternative —
a labelled element with circular 28x28 satellites at the trailing edge
(`gui/src/styles.css:333-346`).

Rejected: adding a second full-width row for restart. Two adjacent full-width
buttons, one of which stops the proxy, invites a misclick and doubles the vertical
cost of a foot that already holds four rows.

Rejected: placing the new control inside `SidebarGithubRow`. That component owns
repository affordances; proxy lifecycle is not one of them.

**Decided:** a new `.sidebar-action-row` container reusing the existing
`.sidebar-orb` satellite class, with both actions as icons.

**Mobile constraint found during audit:** the mobile stop button is widened to a
44x44 touch target (`gui/src/styles.css:2115`). A bare 28x28 `.sidebar-orb` on
mobile would be a regression, so the mobile rule sizes both orbs to 44x44.

## 4. Windows termination: ladder vs leave-as-is

**A — apply the proxy's ladder.** `killProxy` uses
`%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` on Windows and
SIGTERM-then-SIGKILL elsewhere (`src/lib/process-control.ts:150-167`).

**B — keep SIGTERM-only and let the `partially_stopped` response carry the news.**

Windows `process.kill(pid, "SIGTERM")` is already `TerminateProcess`, so on that
platform option A is not an escalation — it adds child-process cleanup to a
termination that was hard either way. On Unix, SIGTERM-then-SIGKILL *is* a real
escalation, and a second harder signal to a process that may be mid-turn asks a
harsher consent than a restart click gives.

**Decided:** asymmetric. Windows gets `taskkill /T /F`; Unix stays SIGTERM-only.
The asymmetry is recorded in the function's doc comment so a later reader does not
"fix" it into symmetry.

**Resolver note found during audit:** `resolveTrustedWindowsTaskkillExe` does not
exist. `src/lib/windows-elevation.ts` has `resolveTrustedWindowsPowerShellExe`
(`:192`) and `resolveTrustedWindowsSchtasksExe` (`:206`), both anchored to a trusted
system directory with a test-override slot. The new resolver follows those, not the
looser `process.env.SystemRoot` string interpolation in `process-control.ts:157`.

## 5. Testability: dynamic imports vs an injectable service

The first draft had the route dynamic-import production modules and call them with
no arguments. That cannot be driven by a test: `ManagementApiDeps`
(`src/server/management/context.ts:11`) has no seam for sync, classification, or
termination, and the six planned route scenarios all require one.

Rejected: adding three seams to `ManagementApiDeps`. That type is already large and
these three belong together.

**Decided:** a service module with its own io interface. The route becomes a thin
adapter, and every branch is driven at the service level.

## 6. Delivery: direct push vs pull request

`src/AGENTS.md:20` classifies management-API changes as a security boundary, and
`MAINTAINERS.md:48-52` requires explicit security review for them; GUI changes need
a screenshot in the PR description (`MAINTAINERS.md:24-27`).

The repository owner directed a direct `--no-verify` push to `dev` for this unit.
That is the maintainer exercising their own merge authority, not an agent bypassing
review, so the instruction stands.

**Decided:** push directly as instructed, and compensate for the skipped local hook
by running the full gate set (typecheck, test, privacy scan, GUI lint/test/build)
before pushing, plus the Linux cross-check on `lidge`. Repository CI remains the
final enforcement layer on `dev`.

