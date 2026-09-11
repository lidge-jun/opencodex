# Lane N — CommandCode effort ladders and the localized Windows ownership probe

Unit for the work-phases that ran after the bug-PR queue reached zero: two
reported defects that were still open as issues, plus two concurrency gaps in the
merged pool-401 path.

## wp20 — #2883, GLM-5.3-Flash advertises no efforts

`z-ai/glm-5.3-flash` reached the Codex catalog with `supported_reasoning_levels`
empty, so the App's picker rendered nothing and requests carried
`requestedEffort: "none"`.

The table in `src/providers/command-code-efforts.ts` held `zai-org/GLM-5.3`. The
live route shares neither its vendor prefix nor its model, and `modelRecordValue`
matches exact, colon-family, or case-folded ids only, so `configuredReasoningEfforts`
fell through to the provider-level `reasoningEfforts: []` and
`applyProviderConfigHints` wrote that onto the model.

Decision: add one explicit row, keyed to the exact upstream id. Do NOT relax
`modelRecordValue` — a stem or substring match would merge two different upstream
models across two vendor namespaces, for every provider at once. The row also
widens `knownModelIdsForProvider`, so the Codex-facing slug decodes back to the
native id.

Ladder provenance: measured, not reported. The profile page renders client-side,
but the delivered HTML ships a serialized payload whose string table decodes as
`224=low, 225=medium, 226=high, 227=xhigh, 569=max`; this model's array is
`[224,226,569]`. The index map reproduces all six rows the same page carries that
were already committed here. No authenticated upstream probe was performed.

Landed: a05dd252d (#2917). Issue closed manually — PRs target `dev`, so GitHub
does not auto-close on merge.

## wp21 — #2914, zh-CN `ocx sync` cannot prove ownership

Two failures compounding. The targeted `schtasks` query answers in CP936 and
`legacyEncodingForLocale` had no `zh` mapping, so the bytes arrived as mojibake and
no message match was possible. That leaves the locale-neutral full listing as the
only evidence, and it was bounded by the 2 s targeted-query budget while taking
12.3 s on a host with 401 tasks.

Decision: name the CJK ANSI pages (`zh`→gbk, `zh-Hant`/TW/HK/MO→big5, `ja`→shift_jis)
and give the listing its own 20 s budget through a per-call override, leaving the
targeted queries at 2 s.

Rejected during implementation: deriving the host's own not-found wording from a
control query against an unregistrable task name. It looks like the general fix and
is unsafe — `schtasks` exits 1 for both "not found" and "access denied", so a
locked-down host answers control and real queries identically and the comparison
yields a false `absent`. The existing access-denied test went red immediately. The
reasoning is recorded in the source comment so it is not rebuilt later.

## wp22 — #2892 gaps 1-2, shared refresh-flight cancellation

Refresh flights are shared per grant, but the flight's abort signal folded in the
initiating caller's signal, so one cancelled request aborted the fetch every joiner
depended on — and a joiner cannot distinguish that from an upstream failure, so a
closed tab could mark a healthy account for reauthentication.

Decision: the flight owns its lifetime (stale eviction + 30 s ceiling); callers wait
through `awaitOwnCancellation`, which honors only their own signal. Both wait sites
use it — changing only the joiner's would have stripped the owner's cancellation
instead of scoping it.

Gap 1 (a superseding credential must also be fresh) ships as one comparison but
without a red-proven test: three interleavings each landed on a different branch.
The source comment says so explicitly rather than leaving a green assertion that
proves nothing.

Gaps 3-5 remain open, and gap 5 is the separate recovery-budget PR the issue asks
for.

## wp23 — #2923, the 20 s listing paid twice per startup

A regression from wp21's own fix. `startServer` inspects ownership twice on
purpose, so the widened listing budget was paid at both sites: ~25 s measured,
40 s at the ceiling, before `Bun.serve`.

Two designs were written in parallel. Mine (#2927) scoped a caller-owned cache to
"one startup"; @Ingwannu's (#2928) keys reuse on the targeted query's exact bytes
and status. Theirs is stronger — it binds the absence proof to the evidence that
produced it rather than to a time window — so #2927 was closed in its favor.

Review found one real gap in it: the first version cached a *stalled* listing, so
one transient 20 s timeout left ownership unprovable for the whole startup,
refusing the write #2914 exists to allow. Reproduced, then fixed on the
contributor's branch (only a successful listing is retained) with a test whose
targeted stderr is byte-identical across both passes, so nothing but the
stall-handling can force the retry. Also pinned `statePaths` in the `startServer`
case, which was reading the developer's real installation and reporting `foreign`
locally while passing on CI.

Landed 09a50299e (#2928).

## wp24 — #2925 and #2929, contributor overlap

#2925 re-fixed #2914 independently and reached the same conclusion on the code
pages. It conflicted with the already-merged fix, so it was closed — but its
identity-budget half was the piece deliberately deferred in wp21, and its
argument (the CI gate existed *only* to widen that constant, so the desktop/CI
split is vestigial) was better than "raise the number". Landed separately as
1d9b389c1 (#2926) with credit.

The localized-substring fast path from #2925 was not taken: each added substring
covers one more language someone thought of, and each is a chance to read a
different refusal as absence.

#2929 fixed dashboard combo strategies collapsing `random`/`least-used`/
`reset-window` to `failover` — saving an untouched combo silently rewrote it.
Verified by mutation independently (`Expected: "random", Received: "failover"`)
before merging as 112db9e12.

## Outcome

Zero open bug-labeled pull requests. Issues #2883, #2893, #2914 and #2923 closed;
#2892 remains open for gaps 3-4, and #2885, #2813, #1527, #1419 are unchanged.
