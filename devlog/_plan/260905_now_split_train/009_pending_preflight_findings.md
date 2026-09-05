# 009 — Pending layer preflight findings

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority. WP480 amendments were incorporated into frozen ddb7013a, now deferred. Other preflights remain unapproved historical proposals.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Read-only gpt-6-astra high preflights while CI is serialized. These are
preparation findings, not official P/A approval or runtime verification.
Source basis is `a687eb735afc7307f902816972c2f8fb522ed2f3`; refresh each layer
against its actual base before implementation. No pending source was edited.

## WP480 — lab event validation

All31owned declarations match the planned ranges;18move,13remain. Projected
four leaves are71/98/181/117lines and facade301, with445lines relocated.
All7public names and41imported bindings remain. Candidate local graph has13
files, no unresolved edges or facade/leaf cycles. Both private fact-key Sets
remain single-owner; post-validation order must remain unchanged.

Three amendments are required in `480_lab_events_validate.md`:

- Line209: replace dedicated-worktree/local/shared-remote verifier with the
  same-a2c0, exact-head, isolated remote-only recipe and complete exit/output.
- Line184: specify a small existing-test delta, including forwarded functions,
  error-class identity, private-export exclusion and moved-validator behavior.
- Line203: the purported moved event-ID validator actually stays in the
  facade. Use a moved sorted/duplicate-ID guard and its ledger test near345
  for a discriminating negative; retain event-ID as integration coverage.

The raw-churn escalation at144 is superseded by003's pure-move/non-move rule.
Smallest unit remains one facade/four-leaf PR, not WP490 implementation.

## WP530 — conformance executor

All25declaration ranges match;17move,8remain,376body lines relocated.
Leaves95/179/146 and corrected residual341lines preserve4runtime exports
and14direct consumers. Candidate graph has374files and42inline-import edges,
with no new return cycle. Preliminary raw churn833/non-move81 must be
measured again after actual implementation and test amendments.

Three amendments are required in `530_lab_conformance_executor.md`:

- Line132: retained `parsedFromContext` still needs
  `import type { OcxParsedRequest } from "../../types";`.
- Line199: always returning fixture JSON cannot fail the cited empty-events
  fallback test. Add a nonempty-event case to the existing regression file,
  with independent expected output, plus forwarding/private-export checks.
  A second moved continuation control can remove prepended tool calls and
  target the existing correlated-pairs case.
- Line205: replace obsolete local/shared-remote verification. Keep adapter/
  budget disposal, reader release and response-store cleanup inside finally.

One independent facade/three-leaf PR remains appropriate. No480 or540–570
implementation is required by this layer. No import-time allocations allowed.

## WP020 — error predicates

The old457-line basis is now496lines. The plan omitted the location predicate
and private pattern tuple, shifting every subsequent range:

| Declaration | Correct basis range |
|---|---|
| LOCATION_UNSUPPORTED_PATTERNS |136–145|
| isLocationUnsupportedMessage |147–150|
| isClientClosedMessage |160–169|
| classifyError |171–321|
| isRateLimitOrQuotaFailureMessage |327–344|
| parseRetryAfterFromMessage |347–360|
| inferHttpStatusFromAdapterMessage |363–421|
| adapterFailureFromMessage |424–448|
| httpStatusFromTerminalError |451–496|

Move complete25–169chunk:145lines/12declarations into
`src/lib/error-message-predicates.ts`, leaving355lines/8declarations in
errors.ts. Source churn294; four export modifiers and four scaffold lines
are non-move wiring. Public boundary is15exports (14runtime+1type), not14.
Forward7moved public names, including the location predicate; import9local
bindings. The location tuple stays private and four former private predicates
stay leaf-only. Retain rate-limit classification and retry parsing in errors.ts
to avoid a return dependency. Neither owner needs imports, so no new cycle.

Importer census is24files (17production/7tests), including the omitted routing
combo failover test. Extend existing error-fidelity coverage for all8location
phrases, uppercase and negatives; preserve status/permission/5xx precedence.
Negative controls: ACLfalse→503case red; locationfalse→public classification
case red; overbroad client-close→false499rejected. Each mutation is remote-only
and restored before green. No caller migration or new test file needed.

Before P/A, amend020's basis/ranges/counts/export lists, module-state wording,
dev-based independence criterion, and remote-only verifier. Its source and
the inspected tests have no diff between this basis and the subsequently
observed6b85485fdev, but this observation is not permission to skip a fresh
base check when execution actually starts.

## WP050 — provider metadata leaves

Read-only basis6b85485f32f783bafc61c79185d0cb937848859d: registry3251lines,
146declarations. Preserve the newer alias field/value; refresh stale ranges.
Six self-contained leaves relocate814lines/120declarations with no imports:
frontier202, reasoning155, coding-plan133, Kimi49, NIM82, gateway193.
Retaining the header and adding six imports leaves2443lines; later060/070
remain necessary. First-layer source arithmetic820add/814delete, only6wiring
lines before tests. No new facade re-export is needed; retain11types/12values.

The new leaves cannot create return cycles. Existing witnesses include erased
type edges; do not claim the whole repository is acyclic. Preserve original
provider allocation/order and validation, shared Kimi references, deliberate
Anthropic copies, and single ownership of the existing private metadata Set.

Amend the existing provider-registry parity test with shared/distinct identity
checks; value equality alone misses some aliasing regressions. Tie negative
controls to moved metadata, not unmoved provider entries. Refresh importer
census rather than trusting old basename counts. The obsolete local/shared-
remote verifier and already-resolved raw-churn escalation must be replaced.
050→060→070 remains the dependency chain; later contract/FastWire work is not
part of050. This is preparation only, not formal P/A or a runtime result.
