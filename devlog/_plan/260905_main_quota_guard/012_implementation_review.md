# wp1 implementation review and repair

## Provenance/policy round 1

Independent reviewer Ohm returned FAIL; accepted both findings after tracing the actual parser/merge flow.

- High: supplementary tertiary-only monthly headers must not clear a retained weekly99 policy observation. Legacy merge clears weekly on any monthly-only snapshot; policy recovery needs actual monthly-primary provenance. Add a parser -> tagged store -> policy regression. Preserve policy weekly unless a lower weekly reading, passed reset or proven governing monthly-primary replacement occurs.
- Medium: tagged credits-only update must not repopulate the expired ordinary rotation cache from long-lived policy evidence, especially while hard-lock is off. Use separate existing bases for legacy and policy merges; never copy durable-only policy values into `accountQuota`.

RCA: one shared result cannot represent two distinct retention contracts. Keep one window-merging implementation with an explicit narrow policy-mode distinction for supplementary monthly updates, but evaluate it separately against legacy and policy bases. Preserve default-off legacy carry-forward; exclude untagged/cross-identity fields only from the new policy record. No generic cache redesign.

Required repair verification: typed checks after source settles; CI regression proves tertiary-only update leaves policy blocked, expired legacy cache remains absent after credits-only update, and actual monthly-primary replacement still clears obsolete weekly policy. Same reviewer re-verifies blocker closure before publication.

Observed before repair: root typecheck exit0; all four new regression files passed standalone TypeScript7 checking with --ignoreConfig. No local tests executed. Privacy scan passed before final integration; final scan remains due if subsequent edits affect it.

## Native admission round 1

Reviewer Tesla returned FAIL with one accepted high blocker: the common Responses resolver also runs for key-authenticated non-Codex providers, assigning a synthetic main context. Passing the policy config unconditionally into its materializer would incorrectly reject routed providers when the caller happened to present the matched main bearer.
RCA: credential identity is necessary but not sufficient; the selected destination must actually consume Codex credentials. Gate both final materialization checks by the existing canonical Codex-forward transport predicate, including custom-named canonical providers. Do not weaken native/Direct/exact-main protection. Add a handler-level regression with the same caller, blocked native request and successful independently keyed route.
This is compatible with the provenance repairs: those determine whose quota; this repair determines whether that quota applies to this destination. Reuse the same reviewer for closure. No broader routing redesign is authorized.

## Provenance/policy round 2

Original tertiary-clearing and legacy-TTL findings are closed; user5h-first selection is accepted. Reviewer found a different producer gap: Go/Free WHAM monthly-primary parsing does not emit `monthlyIsPrimaryWindow`, so a same-owner transition from weekly to monthly leaves stale weekly evidence selected. Accept the finding. Preserve the existing provenance flag whenever a genuinely explicit monthly primary is parsed, including Go/Free; supplementary-only monthly remains insufficient. Add parser -> same-owner store -> policy coverage for weekly98 to monthly99 and weekly99 to monthly20, with no short tuple. This fixes the producer rather than weakening the policy merger.
