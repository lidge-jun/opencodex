# Lane D late-review follow-up

This follow-up starts from landed dev `3ada270f3a0d955ad02b6a4f8f74b0412906bcb1`.
The earlier verification record describes its inspected scenarios, not a claim
that late review could find no further defect. Existing Doctor fixes remain intact.

## Comment dispositions

| Comment | Disposition | Evidence and change |
| --- | --- | --- |
| 4172062340 | Accepted | `gui/src/pages/integrations/FileIntegrationPage.tsx` reuses the omission-aware review path. No draft sends no defaults map; an explicit empty map still clears defaults. The GUI regression exercises Update and Save / review through preview and commit. |
| 4172062382 | Accepted | `src/clients/config-export/droid.ts` filters inherited defaults against the current normalized model's declared efforts. Refresh removes unsupported headers and preserves compatible peers. Regressions cover incompatible, empty and unknown ladders plus explicit clearing. Ownership checks are unchanged. |
| 4172062352 | Accepted | `gui/src/pages/Usage.tsx` shares a finite-number guard across summary, tables, tooltips and assistive text. Malformed rates are unavailable. Regressions cover null, strings and nonfinite values. |
| 4172062362 | Accepted | `gui/src/use-model-visibility.ts` treats JSON integration details as optional after a successful write. Empty/non-JSON success still reconciles against the catalog; transport failures retain their existing error path. Regressions cover 204 and text responses. |
| 4172062394 | Rebutted | `structure/dashboard-and-usage.md`, the English dashboard guide, `usage.throughput.title` and `src/usage/summary.ts` explicitly define qualifying **attempts**, with one sample for a legacy row without attempts. Changing this to distinct requests would change the accepted contract. No aggregation semantics changed. |
| 4172062396 | Accepted | `tests/usage/usage-throughput.test.ts` identifies the second request's model and asserts two model rows at 10 and 15 tok/s with one sample each, alongside the weighted provider/summary rate. |

## Focused verification

From `gui/`:

```sh
bun test --isolate ./tests/models-visibility-queue.test.tsx ./tests/usage-custom-range.test.tsx
bun test --isolate ./tests/integrations-surfaces.test.tsx
```

The first command reproduced seven failures before the display/response fixes
(39 passed); after repair it passed **46/0**. The second passed **58/0**.
Droid regressions were added before its source edit but were not run red;
no Droid red-green claim is made.

From the repository root:

```sh
bun test ./tests/usage/usage-throughput.test.ts
bun test ./tests/clients/droid-managed-reasoning-defaults.test.ts ./tests/server/management-droid-reasoning-defaults.test.ts ./tests/responses/droid-reasoning-defaults.test.ts
```

These passed **5/0** and **44/0**, respectively. All batches were sequential;
none reported skips. Structure, file-size ratchet and privacy checks passed.

Three fixture-browser regressions exercised malformed string throughput across
all three displays and a 204 visibility write through successful reconciliation.
The Droid no-draft review also opened confirmation with the defaults map omitted.
All passed; the throughput/visibility run had no uncaught page errors. Screenshots were inspected and
remain outside tracked source. An initial browser assertion also selected cache
cells; narrowing its selector to throughput corrected the harness, not the product.

Broad typechecks, builds, full suites, Windows/native and real-client acceptance
remain unrun locally. Final PR/CI and production-readiness judgment belong to the
coordinator. No push, PR, merge, installation or release is part of this lane.

Independent inherited review of the final source/tests/docs returned **PASS**,
with no blocking findings; it supported all five accepted fixes/test improvements
and the attempt-count contract rebuttal. This is a technical review, not final
production-readiness approval.
