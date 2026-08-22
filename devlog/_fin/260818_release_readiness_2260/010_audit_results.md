# 010 — Hard-audit results

Four read-only grok-4.6 audit workers + two gpt-5.6-sol design reviewers +
full local/remote gates, run against tip `b04cd26e7`. The audit found
**three release-blocking regressions**, all introduced by same-day merges and
all fixed in **PR #2010** (merged `fe3bbad97`).

## Blocking findings (fixed)

1. **Keep-alive re-arm (from #1941).** The comment-line SSE keep-alive never
   re-arms codex-rs's event-level idle timer (110 RCA already proved this).
   Fixed: typed `response.heartbeat` default restored; grok surface opts
   into comment style via `heartbeatStyle` threaded from `logCtx.surface`.
2. **JWT plan clobber (from #1998).** A JWT-derived plan could overwrite a
   live WHAM plan on token refresh or startup reconcile (in-memory dedupe
   dies on restart; generation gate is credential-CAS only). Fixed:
   persisted provenance (`planSource` + `planCredentialGeneration`);
   JWT writes refused at the same credential generation as a WHAM
   observation; newer generation legitimately reopens.
3. **Unclassified chat tier projection (from #1965).** Retiring the legacy
   chat serialize-collapse flipped no-config openai-chat providers from
   `false` to `undefined`, breaking `require.serviceTier: "unsupported"`
   routing. Fixed: unclassified chat route with no tier forwarding projects
   `false` again; `chatServiceTier: true` and Responses-wire keep unknown.

## Clean areas (worker verdicts)

- **Windows stack**: wrapper killer one-install scoped (full-path
  token-bounded matcher); no writer lost the atomic-replace retry envelope;
  counters bounded (24 keys max), off the hot path; unix untouched.
  Nonblocking: sibling-prefix home test gap, type-only publisher bound.
- **Cursor/codex singles**: #1997 role change has no user-role consumer left;
  #2005 coercion cannot change tool semantics (schema-gated); #1928 stays
  behind full JWT + loopback validation; #1941 annotations backfill is
  add-only.
- **Hygiene**: core-lab-boundary + repo-hygiene 24/0, privacy scan pass, no
  gitlinks, no pre-disclosure security material, no scratch/credential paths
  in the delta.

## Gates on the fixed tip (fe3bbad97)

- Remote authority host (ssh lidge): `tsc --noEmit` clean +
  `bun test --isolate tests` **13208 pass / 0 fail** (EXIT=0).
- Local: 11 focused suites 705/0 + tsc at the merged head.
- Cost-accounting finding from B0 review confirmed fixed (4d87bce04);
  residual tierOutcome-replacement note recorded as non-blocking.

## Non-blocking follow-ups recorded

- structure/04 claims chat passthrough emits service_tier by default —
  docs drift, needs a line fix.
- #1942/#1849 still need their own fixes on the landed Windows foundation.
- #1926 credential-scope half; #1587 (now `bug`) token-bloat design cycle.
- Stall-deadline race note: grok idle floor vs OCX stall default (both 300s)
  — worth a config nudge in the grok inject defaults later.

