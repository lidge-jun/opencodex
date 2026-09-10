# Unresolved after the reflection check

The architect reflection returned MISALIGNED with five findings. Two were document
coherence and are fixed in `000_plan.md`. These three are real and are **not**
closed. B does not start Phase 3, and does not implement CLAMP-04, until they are.

## GAP-1 — CLAMP-04 contradicts tests that `030_test_impact.md` promises to keep green

CLAMP-04 says a leftover diagnostic listing only `max`/`ultra` should stop counting
as an active clamp. But `tests/codex-integration/codex-runtime.test.ts:601` and
`:624` seed `persistEffortClamp` with exactly `removedEfforts: ["max","ultra"]` and
`["max"]` and then assert the diagnostic **is** active. `030_test_impact.md` lists
both as must-keep-passing. Both cannot be true.

Two more files assert the same leftover shape live and are missing from `030`
entirely: `tests/cli/cli-status-json.test.ts:376` and
`tests/config/settings-stream-mode.test.ts:145`.

Phase 1's accept criteria also require same-path-same-version to still return
`true` — which is precisely the leftover file on the reporting machine.

**Disposition: RESOLVED 2026-09-11 — CLAMP-04 ships.** The user authorised the full
cycle with the working tree already carrying the CLAMP-04 implementation
(`liveRemovedEfforts` in `src/codex/runtime.ts`, doctor/status/config-routes aligned
to it, and the four seed-test rows inverted to `["xhigh"]`). That is the recorded
decision; see `050_revalidation.md`.

Independent of that choice: `src/cli/doctor.ts:1180` did not call
`effortClampAppliesToRuntime`, so doctor and status could disagree about one file.
**Historical as of 2026-09-11** — `doctor.ts:1182-1189` now calls the shared
predicate; recorded in `050_revalidation.md`.

## GAP-2 — Phase 3 names a consumer that cannot consume

The reflection is right that the field chain skips a stage. The roster result is a
`ReadonlySet<string>` on `CodexModelEntitlementSnapshot.modelsByAccount`; there is no
presentation payload anywhere until that cache shape changes.
`finishUpstreamNativeEntry` (`sync.ts:257`) clones the pin and takes no roster data,
so naming it as the consumer describes a path that does not exist. The missing
stages are fetch → snapshot shape → sync plumbing, and the plan names none of them.

Worse for the stated goal: **Astra is not account-gated.**
`ACCOUNT_GATED_NATIVE_OPENAI_MODELS` (`src/codex/catalog/native-models.ts:50`) is
Daybreak alone, and `availableAccountGatedNativeModels`
(`model-entitlements.ts:1074`) filters only that set. So "a native slug the roster
already authorises" excludes the one model this whole thread is about. Overlaying
roster copy onto Astra is a new use of `/models`, not a descriptor on an existing
allowlist.

And Daybreak — the one slug the roster does authorise — is a capability alias whose
`availability_nux` is deleted at `metadata.ts:567`. Phase 3 asserts the alias still
loses the field while also asserting the roster wins over the pin. Merge order is
unspecified, so those two accept rows can contradict each other.

**Disposition: Phase 3 is withdrawn from the executable plan** and reduced to a
question: does `backend-api/codex/models?client_version=0.154.0` return
`availability_nux` for `gpt-6-astra` under a real account? If no, the whole phase
dies and the answer to "why is there no Astra card" is simply that upstream has not
shipped copy for it. If yes, Phase 3 is re-planned from the snapshot shape up, not
patched into `finishUpstreamNativeEntry`.

## GAP-3 — citation nits

- `020` cites `codex-catalog.test.ts:7398` for the native-keeps-eligibility pin; `:7398` is the comment, the test is `:7400`.
- `020` cites Sol's `availability_nux` assertion at `:3529`; it is `:3530`.
- `030` lists `client-catalog-compatibility.test.ts:97` as a fourth `#4207` case; it is an assertion inside the test at `:83`.

Left uncorrected in place deliberately — the reflection is the record, and rewriting
the numbers without re-reading the files would be the same class of error.
