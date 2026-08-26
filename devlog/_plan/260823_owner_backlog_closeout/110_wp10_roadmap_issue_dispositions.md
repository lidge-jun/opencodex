# 110 — wp10: the four roadmap issues (#1478, #1049, #1048, #820)

Four of the nine owner issues are accepted architecture work, not defects. The
honest disposition for each is to stay open with a stated reason, not to be
closed for tidiness and not to be half-implemented inside a backlog sweep.

Closing an accepted roadmap item because a cleanup pass wanted a zero would
destroy the record of a decision the project already made. Each is re-confirmed
against `origin/dev` and annotated so its next reader knows where it stands.

## #1478 — config rebase provenance for deletion vs unseen keys

Labelled `roadmap`. The rebase-on-save from #1273 cannot distinguish "this
writer deleted the key" from "this writer never saw the key". That is a data
model gap in the merge's inputs, not a bug in its code: no amount of care in the
merge function recovers information the writer never recorded.

Fixing it means adding provenance to persisted config — a schema change with a
migration and a compatibility story for every existing install. That is its own
cycle. **Retain.**

## #1049 — adopt pre-substrate Codex homes into the write coordinator

Already given a deferral verdict in
`devlog/_plan/260822_backlog_disposition_program/060` and `061` during the prior
program, and nothing since has changed the calculus. Coordination covers clean
first applies and homes that already carry a valid coordinator; a home routed
before the substrate existed keeps its old uncoordinated path — which is every
install predating the substrate.

The reason it stays deferred is that adoption has to be safe on a home that may
be mid-write by an older binary, and that safety argument is the actual work.
**Retain, deferral standing.**

## #1048 — WP13 composed acceptance at the production boundary

Partially implemented: PR #1106 landed the workstation-safe composed acceptance
suite and six production-path scenarios on `dev`. What remains is the Windows
leg, which is exactly what #2152 addresses — so this issue's remaining scope is
now tracked by concrete work rather than being open-ended. **Retain, linked to
#2152.**

## #820 — 32 concurrent tool-recall sessions, protocol-safe and memory-bounded

Labelled `roadmap`, `architecture`. Defines a concurrency and memory
architecture for 32 sustained sessions with a 64-session burst, with no
OpenCodex-imposed serialization and no loss of Codex, Responses, Chat
Completions, Anthropic, or MCP compatibility. That is a program, not an issue.
**Retain.**

## Why this is a real disposition

Every one of these gets an annotation comment on the issue recording its current
state against `dev` today. "Still open" with a dated reason is a verdict; "still
open" with silence is a backlog.


## Execution record

All four annotated 2026-08-23 with a dated state check. Comments posted, then
rewritten via the API: the first attempt was assembled through a shell argument
and had its backticks and newlines eaten. Worth noting rather than hiding — the
repaired bodies are the ones now live.

| Issue | Comment |
|---|---|
| #1478 | 5386880900 |
| #1049 | 5386880991 |
| #1048 | 5386881069 |
| #820 | 5386881161 |
