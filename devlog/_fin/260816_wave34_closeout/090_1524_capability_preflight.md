# 090 — #1524: check capability before falling back

## Verified defect

Fallback reuses the ORIGINAL evaluation instead of re-checking the physical candidate: `policy-fallback.ts` carries forward frozen `eligible`, empty exclusions, the old score, and "not tried" state (`src/server/responses/policy-fallback.ts:26`, `:153`).

The runtime eligibility hook checks only whether an encrypted agent task can be decrypted (`src/server/responses/core.ts:1271`, `:1291`, `:1463`). Combo selection checks configured/enabled provider, prior attempts, caller eligibility and cooldown (`src/combos/resolve.ts:85`, `:97`, `:169`) — nothing about whether the request FITS.

So a 200k-token conversation or an image-bearing request can fall back onto a candidate that cannot accept it.

## What already exists

- Capability evidence resolves context windows and image support from config, registry, catalog or native metadata (`src/routing/capability.ts:153`, `:163`, `:174`).
- The INITIAL evaluator can already reject on supplied context/image requirements (`src/routing/evaluator.ts:187`, `:209`, `:280`).
- Request evidence detects tools and images but leaves request context size UNKNOWN (`src/routing/request-evidence.ts:36`).

The missing pieces are (a) an actual request-size measurement and (b) re-running the existing eligibility check at fallback time.

## Two mechanisms, two fixes

There are two independent fallback paths and one change does not cover both. Splitting them is the difference between a fix and a half-fix.

Also note what already works: policy routing DOES evaluate image requirements for every candidate, and every concrete retry runs `checkInputAdmission` (`src/server/responses/input-admission.ts:159`, called at `src/server/responses/core.ts:1956`) before upstream I/O. So an oversized request is not silently sent — the real defect is that an incompatible candidate TERMINATES the fallback chain instead of being skipped so the next one can be tried.

### (a) Policy fallback

1. Populate request context size in `PolicyRequestEvidence` (`src/routing/request-evidence.ts:36` leaves it unknown).

   **Measurement point matters.** `estimateInputTokens(parsed, modelId)` (`src/server/responses/input-admission.ts:89`) needs a model id, and routing runs BEFORE a model is chosen — so it cannot be called as-is at evaluation time. Compute a model-independent estimate once from the parsed request and store it on the evidence; each candidate then compares that figure against its own ceiling.

   **Use the same threshold as admission.** `checkInputAdmission` refuses only past `ceiling * ADMISSION_TOLERANCE` where `ADMISSION_TOLERANCE = 2.5` (`input-admission.ts:32`, `:168`). If the evaluator excluded on exact fit while admission tolerates 2.5x, routing would refuse candidates that would actually have worked, which is a new outage in the name of a fix. Apply the same tolerance, and state it in the exclusion reason so the trace explains itself.
2. In `policy-fallback.ts:153`, re-evaluate each candidate against the CURRENT evidence instead of reusing the frozen verdict, using the evaluator's existing context/modality rejection.

### (b) Combo fallback

`policy-fallback.ts` is not on this path. Combo selection needs `payloadEligible` (`src/server/responses/core.ts:1463`) extended beyond encrypted-task decryptability to consult the same capability evidence. Without this, the combo path cited in the issue is unchanged.
3. Unknown capability is NOT a pass. When neither config, registry, catalog nor native metadata can answer, treat the candidate as ineligible for a request that requires the capability, and record the reason — the issue explicitly asks for conservative-unknown handling.
4. Never truncate history or drop images to force a candidate to fit. If nothing is compatible, fail with a typed reason naming the constraint.
5. Preserve quota/cooldown/priority semantics: capability is an additional filter, not a replacement ordering.

## Tests

Cover BOTH paths explicitly:

- Policy fallback: a candidate with a smaller context window than the request is skipped and the next compatible one is used — not treated as the end of the chain.
- Combo fallback: the same, through `payloadEligible`.
- An image-bearing request skips a text-only candidate on both paths.
- A candidate with unknown modality support is skipped for an image request but still usable for a text one.
- No compatible candidate produces a typed failure naming the constraint, not a silent truncation.
- Cooldown and prior-attempt exclusion still apply unchanged.

---

## Implementation outcome (verified at `812e7c40b`)

The plan above proposed two mechanisms. Tracing the actual code changed what was needed.

### What shipped

A distinct `input_admission_refused` code (`src/server/responses/core.ts:1979`) that is
`hop`-eligible in `comboFailureDecision` (`src/combos/failover.ts:132`), while upstream
`context_length_exceeded` still stops (`:124`).

This covers BOTH fallback paths, which the plan assumed needed separate fixes:

- **Combo fallback** consults `comboFailureDecision` directly.
- **Policy fallback** consults the SAME function — `shouldHopPolicyCandidate`
  (`src/server/responses/policy-fallback.ts:72`) delegates to it, which the plan missed
  when it proposed re-evaluating candidates inside `policy-fallback.ts:153`.

So the context-window half of #1524 is closed by one change rather than two.

### What the plan got wrong

- **"Fallback reuses the frozen verdict, so a candidate is never re-checked" understates what
  already worked.** Every concrete retry re-enters `handleResponses`, which runs
  `checkInputAdmission` against the NEW candidate's own ceiling before upstream I/O
  (`core.ts:1970`). The candidate was always checked; the defect was that its refusal
  TERMINATED the chain instead of advancing it.
- **Modality was already filtered.** `evidenceFromBody` sets `imageInputRequired`
  (`src/routing/request-evidence.ts:43`), and the evaluator turns it into a
  `request-image-input` requirement per candidate (`src/routing/evaluator.ts:209`), producing
  a `capability-unsatisfied` exclusion. `rankPolicyFallbackCandidates` only considers
  candidates with `eligible === true` and zero exclusions
  (`policy-fallback.ts:32`), so an image request can never hop onto a text-only candidate.
  The plan's proposed image tests would have passed before any change.
- **Unknown capability is already operator-controlled, not silently permissive.**
  `excludedByUnknown` (`evaluator.ts:291`) excludes on unknown evidence when the profile sets
  `unknownEvidence.capability = "exclude"`. The plan asked to make conservative-unknown
  unconditional; doing so would change routing for every profile that deliberately allows
  unknown evidence, which is a behavior change the issue does not ask for.

### Remaining gap

Request context size is still `unknown` in `PolicyRequestEvidence`, so the INITIAL policy
evaluation cannot pre-exclude an oversized candidate — it is discovered at admission and then
hopped. That is correct but wasteful: the chain walks candidates one refusal at a time instead
of ranking only those that fit.

Closing that needs a model-independent size estimate computed once and compared against each
candidate's ceiling at the same `ADMISSION_TOLERANCE = 2.5` the admission gate uses
(`src/server/responses/input-admission.ts:32`). Using a stricter threshold at evaluation time
would refuse candidates that admission would have accepted — an outage in the name of a fix.

This is an optimization of an already-correct chain, not the reported defect. #1524's
acceptance behavior ("reject candidates that cannot accept the request before retrying") holds
today for both context and modality.


### Audit round r1 correction (at `bc6019bae`)

The section above was written at `812e7c40b`, BEFORE the real defect was found, and an adversarial
pre-merge audit showed it was describing a fix that did not work. Recorded here rather than
rewritten, because the mistake is the useful part.

**What the earlier section got wrong.** It claimed the context-window half of #1524 was closed by
the `input_admission_refused` hop code. It was not: `core.ts` emits that refusal through
`formatErrorResponse`, which runs `classifyError` — and the message necessarily contains
"context window", because that is what it is refusing on. The generic remap rewrote our own code
to `context_length_exceeded`, so the envelope the proxy actually shipped carried no admission
marker at all. Reordering `comboFailureDecision` was necessary but changed nothing on its own.

The reason this survived earlier review is worth naming: the test fixture hand-built an envelope
the proxy does not emit. A green test proved a shape that never reaches production.

**What now holds, verified by running the production emitter rather than reading it:**

- `src/lib/errors.ts:152` — `classifyError` returns `input_admission_refused` when that is the
  type it was given, placed before the context-window remap.
- `src/combos/failover.ts:141` — the hop rule, matched on the structured code only and tested
  before the generic stop list at `:144`.
- `src/server/responses/core.ts:2003` — the emitter.
- `tests/routing-policy-fallback.test.ts` — the fixture calls `formatErrorResponse` itself, plus a
  negative case pinning that an upstream merely mentioning the token does not hop.

Both factors are independently load-bearing: disabling the `classifyError` branch fails the
regression, and restoring the original ordering fails it too. Neither alone is sufficient, which
is exactly why the first single-factor ablation was misleading — it passed because the removed
`message.includes` arm caught the case.

**Provenance caveat, from the reviewer.** Calling this a "local" code slightly overstates it.
Policy fallback reads `error.code` from any response (`src/server/responses/policy-fallback.ts:61`)
and combo reads the upstream nested code, so an upstream that deliberately emits
`input_admission_refused` induces a hop. That is bounded rather than dangerous: upstreams already
control other hop signals (429, 5xx), and traversal is finite — policy tries each candidate once
via `tried`, combo excludes each attempted target. The accurate description is
**structured-code-only**, not provably local, and the code comment says so.

