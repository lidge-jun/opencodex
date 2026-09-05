# 009.1 — Post-merge Windows evidence

## Baselines

- Original stack: `293f3e675`, two all-green Windows six-shard runs
  `33936695508` and `33937730205`.
- Merged stack: `3c920af5f`, run `33940032334`, job `101236063494`:
  `server-auth.test.ts:4145` expected 499/client_cancel, received
  502/terminal, synthetic, mid_stream, streamAborted=true. Negative upstream
  reset twin passed. The pending macOS jobs were cancelled by the parent after
  the user excluded macOS; a subsequent single-job retry was cancelled by an
  unrelated dev push, so that retry is no evidence.
- Pinned later dev: `593978db0`, run `33941712300`, isolated branch
  `codex/win-dispatch-593978db0` so further dev pushes cannot cancel it.
  Job `101240599941` (1/6) failed the real-second-process quota claim assertion
  (empty stdout, expected true) and the hard-ceiling test (99.26 s against
  60 s). Job `101240599984` (6/6) repeated caller-cancel 502 and failed the
  cold quota burst child (exit 1, expected 0).
- Job `101240600060` (3/6) adds three reconciliation failures: missing
  GET /api/quota-resets declaration and an unresolved lazy dispatcher wrapper.
  The handler and CLI verb already exist; these are integration inventory gaps.
- Job `101240599990` (5/6) fails quota-reset-notify.test.ts:515 because its
  activation fixture configures HTTP despite the HTTPS-only schema. The local
  focused check independently reproduces the same warning and assertion.
  Full pinned Windows baseline: shards2/4 pass; 1/3/5/6 fail, eight assertions.

## Hypotheses and falsifiers

Quota child H1: file URL `.pathname` is passed as a native script/import path.
Both call sites contain that conversion. Falsifier: stderr proves module loading
succeeded and failure occurred later. Child stdout alone cannot establish this.
H2: PATH selected a different Bun; pin process.execPath and observe stderr/exit.
H3: persistence failure; the claim API prints false on a caught write failure,
not empty output, so this does not explain the observed first-child signature.
Existing corpus case `env-paths/file-url-pathname-drive-slash.md` covers the
conversion and diagnostics gap; no duplicate case is needed.

Ceiling H1: fixture construction performs excessive real persistence. The first
1024 claims persist; the remaining 976 newcomers are immediately evicted before
persistence. H2: pruning is intrinsically slow; a near-boundary fixture with the
same eviction still falsifies that. H3: an unrelated child stall dominates;
constant-write timing will distinguish it. Do not label this measured fsync
overhead: the inspected atomic writer uses synchronous persistence and Windows
ACL subprocesses, and exact per-operation time has not been measured.

Cancellation H1: Windows forced rewrite selects eager despite legacy-tee, and
eager lacks caller-cancellation provenance. `core.ts` passes caller abort to the
fetch controller but gives eager a separate turn controller; the link is one-way.
H2: transport fails before the caller signal is observed; requires event-order
evidence. H3: shared fixture/log contamination; weakened by request-ID filtering,
fresh harness logs and two repeated Windows failures. A deterministic reader
rejection/caller-signal test distinguishes the missing provenance from an actual
upstream reset. Do not weaken the 502 negative twin or the Windows eager safety
override. The old stack did not include this regression test (#3541).

## Boundaries

These are reliability/test-portability findings, not credential-bypass findings.
No unshipped security investigation belongs here. Runtime security boundaries,
workflow permissions, Bun version, shard count and timeout ceilings remain fixed.
