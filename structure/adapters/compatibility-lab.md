# Compatibility Lab

## Core isolation and synchronous activation

The protected core request-path files carry no load-time import chain into Lab runtime code:
the guard in `tests/lab/core-lab-boundary.test.ts` walks static imports, side-effect imports,
and re-exports transitively from the guard-owned `PROTECTED` list and prints the offending
chain on failure. A dynamic `import()` is a deferred edge the walk deliberately does not
follow, because lazy loading behind a namespace or activation check is the sanctioned remedy —
so the same guard separately forbids a protected file from naming Lab even in a direct dynamic
import. The ordinary no-Lab path therefore executes no Lab code, while the management plane can
still route `/api/lab` lazily through a non-Lab module without weakening the rule.

`src/server/index.ts` is deliberately exempt as the composition root: Lab activation stays
behind `labActivationRequired`, and the window from `Bun.serve` through the `startServer`
return contains no suspension, so a policy route can never be evaluated before its evidence
provider is registered and the subagent fallback chain keeps the operator-configured model.
This contract is [INV-LAB-01](../overview.md#non-negotiable-invariants), bound to the same
guard test.

## CL-03 live-route execution boundary

CL-03 live-route evidence is generated only for an exact `RouteSubjectV1` and remains separate from protocol-conformance and task-effectiveness evidence.

The live runner fails closed before destination resolution unless the selected scenario is applicable and every route precondition, including explicit `lab_run_approval`, is satisfied. Destination resolution is bounded by the CL-03 connect timeout, policy-checks every resolved address, freezes the approved address set, and fingerprints only the immutable destination snapshot. Raw URLs and resolved addresses are not persisted as Lab evidence.

Evidence-eligible route execution uses a host-issued `TrustedLabRouteExecutor`. The public Lab authority surface only recognizes host-issued capabilities; it does not expose a constructor that accepts caller-asserted sandbox boundary names. Test transports remain useful for normalization/classification tests but are never evidence-eligible.

Successful or blocked trusted executions receive a module-private receipt bound to the canonical live authority, scenario ID, suite ID, scenario/suite manifest digests, and exact route subject ID. `observationFromLiveResult` verifies that receipt before creating directories or writing artifacts, so a structural `LiveScenarioRunResult` or mismatched case/authority cannot fabricate live evidence.

The trusted credential sender keeps secret injection outside Lab code and uses the existing pinned HTTP primitive. CL-03 explicitly supplies its connect timeout; other pinned-HTTP callers retain their prior timeout behavior. Only response metadata required by live assertions currently crosses back into Lab (`content-type`); cookies, account/organization metadata, credential-adjacent headers, and rate-limit headers are not exposed.

## Evidence text sanitization

Response *headers* are allowlisted, but assertion summaries carry
provider-controlled *body* text, and that text is persisted in the
`assertion_report` artifact and the observation event. Both sinks are sanitized
at construction by the shared scrubber in `src/lab/artifacts/sanitize.ts`, so
the write path and the read path (`sanitizePublicText`) no longer disagree
about what may be stored.

Redacted: filesystem paths including UNC shares, HTTP(S) URLs, credential-bearing
and other-scheme URIs, JWT-shaped tokens, email addresses including internationalized local parts and domains, prefixed account
identifiers (`acct_`, `cus_`, `sub_`, `org-`), account values under an
ID-bearing label (`user_id`, `userID`, `organization_id`, `accountId`, …; matched case-insensitively), MAC addresses in either colon or hyphen notation, IPv4,
IPv6 including mapped and scoped forms, and multi-label hostnames whose final
label is alphabetic or punycode.

**Hostname limit.** A final label containing digits or hyphens — `db.prod-1`,
`api.us-east-1` — is simultaneously a valid internal hostname and a valid
metric or version namespace (`provider.metric.p95`, `lib.v2-rc1`). Shape cannot
separate them. Those forms are therefore redacted only when an unambiguous
network marker introduces them, and survive otherwise.

Markers carry two confidence levels, because treating them alike lost accuracy
in both directions.

A name paired with a numeric port is a destination on its own evidence, checked
before anything else: `dial tcp redis:6379` needs no further signal.

Otherwise, **strong** markers (`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`,
`ETIMEDOUT`, `EHOSTUNREACH`, `dial tcp`, `host=`/`host:`) introduce a
destination. The destination is not assumed adjacent — Go writes
`dial tcp: lookup <host>: no such host` — so the following few tokens are
scanned and the first host-shaped one is replaced. A bare name counts only in
a position the grammar proves is the destination — directly after `ENOTFOUND`,
`EAI_AGAIN`, or `host=`/`host:` even when explanatory prose follows, the marker's sole argument
(`ECONNREFUSED redis`, `dial tcp redis`) or the argument of `lookup`
(`dial tcp: lookup redis`). Connective prose after a marker survives:
`ETIMEDOUT request after 30 seconds` and `ETIMEDOUT while waiting for
response` are both untouched.

**Weak** markers (`upstream`, `connect to`) read as English at least as often as
they name a host, so they redact only a candidate that is already host-shaped
and is not a plain dotted namespace or the conventional `*.metric.p<digits>`
form. `upstream provider.metric.p95 exceeded` and
`Unable to connect to your account` both survive; `upstream db.prod1` does not.
For `connect to`, an immediately following network failure term also makes a
bare target unambiguous, so `connect to gateway failed` is redacted while
`Unable to connect to your account` survives.

### Known limits

Recorded rather than implied, so a reader knows what is not covered:

| Form | Behavior |
|------|----------|
| Bare `db.prod-1` outside any network context | not redacted — indistinguishable from a metric namespace |
| Bare word amid prose after a socket marker (`ETIMEDOUT operation timed out`) | not redacted — only the marker's sole argument or the word after `lookup` is a proven destination position |
| Standalone UUID, standalone `user_…`, bare-label value (`org: engineering`) | not redacted — indistinguishable from request, trace, and correlation ids |
| Phone numbers, generic high-entropy blobs | not redacted — no non-destructive pattern |
| Cisco dotted MAC (`0123.4567.89ab`), ideographic-dot IDN | not redacted — unusual notations |
| Escaped-quote mail local part | partially redacted; the address is broken but a fragment of the local part can remain |
| Percent-encoding nested more than six deep | not decoded further |
| Fully alphabetic dotted namespace (`provider.timeout`, `provider.request.duration`) | **over-redacted to `[host]`** — indistinguishable from a real hostname. A digit-suffixed namespace survives bare (`release.v2`); after a weak marker only the conventional `*.metric.p<digits>` form does (`provider.metric.p95`) — `upstream db.prod1` and `upstream api.v2` redact |

The marker behaviors and the redacted categories are asserted in both
directions — positive cases for what must be removed, negative cases for the
ordinary diagnostics that must survive — so those cannot drift silently. The
limits table is a description of current behavior; only the entries with a
matching test are pinned, and the unusual-notation rows are not.
A retained URL path also has identifier-shaped content redacted wherever it
appears, independent of the punctuation around it — colon action suffixes and
matrix parameters are ordinary API syntax, so enumerating delimiters does not
hold.

Deliberately **not** redacted, because no pattern separates them from the
diagnostics the Lab exists to capture: standalone `user_…` identifiers,
standalone UUIDs (request, trace, and correlation ids look identical to account
ids), values under a bare label such as `org: engineering`, phone numbers, and
generic high-entropy blobs. A four-component version string like `1.2.3.4` is
redacted as an IPv4 literal; that false positive is known and pinned by a test.
Percent-decoding is bounded at six passes, so a deeper nesting than that is a
recorded limit rather than a covered case.

Rules run in a fixed total order — email before hostname, MAC before IPv6, IPv6
before IPv4, HTTP before other schemes — and every rule replaces a value whole
or not at all, because a prefix replacement looks redacted while the tail
leaks. `enforceEventStructureLimits` remains a backstop that rejects
secret-shaped strings and raw paths; it is not the enforcement point.

Both directions are enforced by tests: every redacted category has a positive
case, and ordinary dotted diagnostics (`provider.metric.p95`, `lib.v2-rc1`,
`foo.bar-baz`) have negative cases, because a sanitizer that destroys evidence
fails this contract as surely as one that leaks it.

Non-contract artifacts declare `redactionPolicy: sanitized_evidence_v2`.
Contract classes (fixtures and manifests) bypass mutation, so their pinned
digests are unaffected.

Live projection preserves the frozen `RouteSubjectV1` schema. Claim-gated scenario applicability is derived from current validated, usable `claim_snapshot` state for the exact subject rather than from caller-provided claim arrays or by extending the V1 subject preimage. A missing/wrong-kind route subject or unavailable claim state fails verification closed.

The two machine-readable Live V1 authority copies are required to be byte-identical. Runtime loading fails closed on byte drift before parsing. Scenario limits use `perArtifactBytes` as the single per-artifact execution-limit key; the artifact policy retains its independent per-artifact policy ceiling.

## CL-07 producer supervision

An isolated fabric producer child is supervised through process exit, not through
its protocol stream: a parsed `result` line is stored, never settled, so an
executor cannot end its supervision early and keep mutating its scratch tree.
Protocol `error` lines, stream failures, and expired budgets latch a kill reason,
SIGKILL the child, and settle only at the run's decision point — so scratch
cleanup can never race a live producer. `exit` is the authoritative end of the
budget window: an already-met deadline still applies, otherwise both budget
timers are disarmed, and protocol bytes drained afterwards are judged at the
exit timestamp. A stored result is accepted only on a clean `code 0` exit
observed at `close`; a nonzero or signaled exit is a harness failure, and a
latched failure always wins settlement. `close` also waits for the child's
stdio, so after `exit` a bounded drain (`EXIT_DRAIN_MS`) lets in-flight protocol
data arrive; if `close` never follows, the run is rejected as an inconclusive
harness failure — a held-open pipe may mean a descendant escaped supervision or
simply that drainage stalled, so the result cannot be trusted and its scratch
cannot be cleaned while reporting success under a possibly-live process.
Rejections that could not observe `close` — a kill that produced neither `exit`
nor `close`, and any `exit` whose `close` never arrived — carry the deferred-
cleanup contract of an unconfirmed kill: the executor retains scratch and emits a fixed
manual-review warning without writing into producer-controlled paths. Later task creation
never sweeps these trees. Marker age and inherited-pipe closure are not termination leases.
After independently confirming all producer/descendant processes stopped, the operator may
review and remove the exact retained tree; parent exit does not grant automatic cleanup.

## Scope guard

CL-03 does not expose a management CLI/API or UI. Those surfaces remain CL-04+ work. Production request routing must not synchronously trigger Compatibility Lab probing or rebuild Lab evidence.

## CL-05 GUI read surface

CL-05 adds a read-only Models tab (`#models/compatibility`) that visualizes the compatibility verdict matrix from existing `GET /api/lab/*` management APIs. The legacy `#lab` hash redirects to `#models/compatibility`. The GUI never triggers probe execution, projection rebuilds, or evidence mutation. Verdicts remain per `(subject, evidence layer, suite)`; layers are not collapsed into a universal score.

## Public-evidence mutation, purge and revocation

Public-evidence mutation is serialized across processes by `src/lab/public/mutation-lock.ts`. A live,
non-reclaimable owner is a fail-fast condition: the caller receives `PublicEvidenceValidationError`
code `community_cache_busy` without running the protected work, and
`src/server/management/lab-routes.ts` maps that code to HTTP 503 with `Retry-After: 1`. Other
public-evidence validation failures stay 400. Rejection leaves the owner's lock bytes and directory
identity untouched.

Sensitive purge removes a community cache pathname that durable local provenance marks as locally
originated, even when the cached object is oversized, hardlinked, symlinked or otherwise unreadable
as a community object. It unlinks the pathname only: it never follows a symlink and never removes a
peer hardlink. `ENOENT` counts as already absent. Origin markers are cleared only after the deletion
pass and its directory durability boundary complete.

A same-publisher bundle revocation whose target is absent fails with code `revocation_target` and the
message `revocation target bundle not found` (`src/lab/public/community.ts`), never a platform
filesystem `ENOENT`.
