# 000 - Problem model: what "macOS-only" actually means here

Unit: cross-platform parity + Windows compatibility fixes.
Branch base: `dev` at `072df52eb`. Date: 2026-09-04.

## The request

Make the capabilities that only work on macOS work on Windows and Linux too, and
land the Windows-compatibility bug fixes the backlog already documents. Delivered
as a stacked pull-request chain against `dev`.

## The claim that had to be tested first

"opencodex is macOS-only in places" is the starting hypothesis, not a finding. A
read-only inventory of every `darwin` gate in `src/` (recorded in `001`) shows the
claim is mostly FALSE and the exceptions are concentrated:

- 21 darwin-referencing sites were classified.
- 13 are ALREADY-HANDLED: they carry real win32 and linux branches today
  (`open-url.ts`, `cursor-detect.ts`, `desktop-3p-paths.ts`, `kiro-credentials.ts`,
  `app-server-processes.ts`, `service.ts` backend dispatch, `key-store.ts`, and the
  Claude credential file fallback in `local-token-detect.ts`).
- 6 are a single subsystem: `src/server/system-env.ts`, which refuses with
  `reason: "not macOS"` at five entry points and holds the launchctl calls behind them.
- 1 is a hard throw: `src/oauth/meta-muse.ts` refuses every non-darwin host.
- 1 is a missing developer script: `scripts/ocx-restart.sh` has no Windows counterpart.

So this unit is not a porting sweep. After four audit rounds it is three phases,
each its own PR in a stacked chain:

- **wp1** - `meta-muse` accepts a pasted Muse Code key on Windows and Linux. The
  key is visible in Meta's own console, so refusing those platforms reported a
  limitation of our importer as a limitation of the platform.
- **wp2** - a platform-support reference page, so the capabilities that stay
  macOS-only have a written answer rather than a silent dead end.
- **wp3** - the Windows identity decode fix, the one defect proven to exist in
  the tree.

Everything else the audits removed is in `050` with its blocking reason.

## The second problem, found while looking

While inventorying the Windows paths, a real defect surfaced in the tree: the
identity ACQUISITION path decodes PowerShell stdout as UTF-8 when Windows
PowerShell 5.1 emits the console code page, so a non-ASCII account name is
mojibaked before any comparison happens. The `<UserId>` comparison itself is
correct. Details and evidence: `003`.

Its relationship to issue #3320 is CANDIDATE, not proven. The reporter's evidence
was collected after a local patch and repair, so the original registration shape
is unknown and nothing here establishes that this defect produced that user's
failure. What can be said conditionally: #3134 moved new registrations to SID
form, and a SID is ASCII, so freshly registered tasks stay healthy; a task
registered by v2.39.0 or earlier carries a name-form `<UserId>`, and for a
non-ASCII account both sides of that comparison are separately corrupted, which
would make `ocx service repair` refuse it permanently. That is a plausible route
to the reported symptom, not a demonstrated one.

## What "done" means for this unit

Every phase below ships as its own reviewable PR against `dev`, stacked so each
child bases on its parent's head branch (DEV-STACK-01), with CI as the verification
authority. The user has forbidden running the full local suite, so no phase may
claim a green suite as evidence; each phase names the focused reasoning or the CI
run that backs it.

## Non-goals

- No provider catalog or model metadata churn.
- No GUI redesign.
- No release promotion to `preview` or `main`.
- No security-triage writeup in this directory (AGENTS.md: scratch only).
- The `go/` directory is untouched.
