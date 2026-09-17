# Devin input-ceiling forwarding review

## Scope and source baseline

Reviewed upstream `dev` at `7868f5df570e5f5fb4be3a4b79b7e83526894e5f`.
This is the request-side gap left after merged PR #4323 fixed catalog reporting.

- `src/adapters/devin/cloud-direct/catalog.ts` reads `ClientModelConfig` field 18
  (`max_input_tokens`) into the exact account/model UID's `contextWindow`.
- `src/adapters/devin/live-models.ts` collapses variants for display, retaining
  the smallest reported window across a base family. That display row must not
  replace the exact selected UID's request-side evidence.
- `src/adapters/devin.ts` forwarded output, temperature and top-p, but omitted
  `completionOpts.maxInputTokens` for every request.
- `src/adapters/devin/cloud-direct/chat.ts` therefore serialized 128000 into
  `CompletionConfiguration` field 3, independently of catalog reporting.
  Output is field 2; changing its allowance or subtracting it is out of scope.

The forwarding discrepancy is established. Whether the hosted backend enforces,
ignores or otherwise uses this request field was NOT measured with a live account.
No claim is made that existing sessions were truncated, or that this patch proves
262k/1M end-to-end long-context quality.

## Implemented boundary

Resolve a positive safe-integer input ceiling for the actual selected wire UID.
The existing per-account/host catalog cache supplies live evidence. Exact model
hints take precedence over collapsed-base hints, then provider context hints;
a separately configured input-token hint also caps the result. Smaller valid
hints cannot raise the live ceiling. Canonical IDs win over alternative saved
spellings; dotted and case-folded hints remain usable. Another effort or opt-in
long-context variant's live window is never borrowed.

No live/config evidence leaves the encoder's existing 128k fallback unchanged.
No new model-size table or configuration field is introduced. Provider-wide
catalog/compaction caps retain their existing client-side behavior; this change
forwards the provider/model hints already available to the adapter, not a new
request-body context override. Output, tools, images, reasoning, usage and
entitlement preflight are unchanged. Cancellation is checked after metadata lookup.

The adapter's metadata read shares the existing cache with selection and chat
preflight. It is not a new inference request. With a warm/successful cache it adds
no catalog HTTP request; on a catalog outage, transport preflight retains its
existing best-effort retry. Cold-failure latency must not be described as identical
to the previous suffix-only path.

## Regression coverage

Extend the already registered `tests/providers/devin-prompt-cache.test.ts`.
The new cases seed a synthetic account catalog and stub HTTP, then drive the real
adapter and Connect-RPC serializer. They inspect input field 3, preserve output
field 2 and prompt-cache field 13, and check exact UID, configuration precedence,
missing metadata, discovery failure, cancellation, disabled/unlisted preflight,
and invalid numeric values. No real credentials or billable inference are used.

## Validation actually performed

An isolated Node/TypeScript harness executed the full modified adapter with
synthetic catalog/auth/transport boundaries: 48 checks passed, zero failed.
The input/output encoder in that harness mirrors the pinned encoder; it is not
an independently executed full hosted transport. The original adapter reproduced
128000 and failed the new 262000 expectation, while the patched adapter passed.
Both changed TypeScript files transpiled without diagnostics. Original retrieved
files were checked against their Git blob SHAs before editing.

NOT RUN: repository Bun tests (including the new real-transport regressions),
repository typecheck, changed/full suites, privacy scanner, structure gate,
or real Devin long-context inference. Bun and a full dependency checkout are not
available in this execution environment. These are not green-CI attestations.

## Review readiness

Keep the PR draft until the repository checks and necessary structure-owner
cross-links are complete. Run at least:

```sh
bun test tests/providers/devin-prompt-cache.test.ts tests/providers/devin-adapter.test.ts tests/providers/devin-hardening.test.ts
bun run typecheck
bun run test:changed
bun run privacy:scan
bun run structure:check
```

Run the full required suite before marking review-ready. Review cold catalog
failure latency separately from the confirmed request-field fix.
