# Compatibility Lab SOT

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
destination, and a resolver marker licenses even a bare name
(`getaddrinfo ENOTFOUND redis`). The destination is not assumed adjacent — Go
writes `dial tcp: lookup <host>: no such host` — so the following few tokens are
scanned and the first host-shaped one is replaced. A plain English word is not
host-shaped, so `ETIMEDOUT request after 30 seconds` is untouched.

**Weak** markers (`upstream`, `connect to`) read as English at least as often as
they name a host, so they redact only a candidate that is already host-shaped
and is not a plain dotted namespace. `upstream provider.metric.p95 exceeded` and
`Unable to connect to your account` both survive.

### Known limits

Recorded rather than implied, so a reader knows what is not covered:

| Form | Behavior |
|------|----------|
| Bare service name after natural-language `connect to` with no port at all (`connect to gateway failed`) | not redacted — the phrase is prose too often to trust. A port in either notation (`gateway:443`, `gateway on port 443`) does make it a host |
| Bare `db.prod-1` outside any network context | not redacted — indistinguishable from a metric namespace |
| Standalone UUID, standalone `user_…`, bare-label value (`org: engineering`) | not redacted — indistinguishable from request, trace, and correlation ids |
| Phone numbers, generic high-entropy blobs | not redacted — no non-destructive pattern |
| Cisco dotted MAC (`0123.4567.89ab`), ideographic-dot IDN | not redacted — unusual notations |
| Escaped-quote mail local part | partially redacted; the address is broken but a fragment of the local part can remain |
| Percent-encoding nested more than six deep | not decoded further |
| Fully alphabetic dotted namespace (`provider.timeout`, `provider.request.duration`) | **over-redacted to `[host]`** — indistinguishable from a real hostname. A namespace whose last label carries a digit (`provider.metric.p95`) survives |

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

## Scope guard

CL-03 does not expose a management CLI/API or UI. Those surfaces remain CL-04+ work. Production request routing must not synchronously trigger Compatibility Lab probing or rebuild Lab evidence.

## CL-05 GUI read surface

CL-05 adds a read-only Models tab (`#models/compatibility`) that visualizes the compatibility verdict matrix from existing `GET /api/lab/*` management APIs. The legacy `#lab` hash redirects to `#models/compatibility`. The GUI never triggers probe execution, projection rebuilds, or evidence mutation. Verdicts remain per `(subject, evidence layer, suite)`; layers are not collapsed into a universal score.
