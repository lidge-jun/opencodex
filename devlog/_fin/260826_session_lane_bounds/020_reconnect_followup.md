# Same-session reconnect follow-up

## Loop spec

- Archetype: repair.
- Trigger: a Codex retry for a trivial prompt receives local HTTP 503
  `active turns capacity reached` while the previous request for the same logical
  session is still settling.
- Goal: allow overlapping/reconnecting requests from one identified session without
  removing the 64-unique-session memory bound or the 256-active-turn process bound.
- Non-goals: no queue, scheduler, timeout change, retry loop, error-envelope change,
  Lab dependency, or broader lifecycle refactor.
- Verifier: `bun test tests/session-lane-recall-harness.test.ts` exercises the same-lane
  HTTP boundary and unique-lane cap; baseline exit 0 and it imports the changed lifecycle
  module directly. `bun run typecheck` baseline exit 0 and `tsconfig.json` includes `src`;
  Bun independently compiles the changed test file in the focused test command.
- Stop condition: same-lane overlap is admitted, the lane stays retained until its last
  lease releases, the 65th unique lane remains rejected, and all required PR gates pass.
- Memory artifact: this document and the focused regression test.
- Expected terminal outcomes: DONE with a focused PR, or BLOCKED if ref-counted cleanup
  cannot preserve the existing unique-lane memory oracle.
- Escalation: the main agent keeps the tightly coupled lifecycle/test change; an
  independent reviewer audits the plan and final diff. Any scope delegated later requires
  a P-phase amendment.

## Root cause and rejected hypotheses

- H1, genuine 256-turn exhaustion: rejected for the reported event because a fresh runtime
  snapshot showed `activeTurnCount: 0`, and the error is also emitted before the global
  gate when a duplicate lane is present.
- H2, permanent active-turn leak: not supported by the post-event snapshot because active
  turns returned to zero. The failure is transient while an earlier stream settles.
- H3, same-session admission collision: supported by `tryAdmitTurn`, which returns `null`
  whenever `activeSessionLanes.has(lane)` and maps that condition to the exact 503 shown by
  Codex. The existing HTTP test codifies that rejection.

## Diff-level plan

### `src/server/lifecycle.ts`

- Replace the unique-lane `Set` with a fixed-key reference-count map.
- Reject only a previously unseen lane when 64 unique lanes are already active.
- Increment a lane's lease count on admission; decrement on idempotent lease release and
  delete only when the last same-lane lease settles.
- Keep `sessionLaneMetrics().active` and retained-byte accounting defined as unique lanes,
  preserving the #820 memory envelope.
- Keep `sessionLaneMetrics().admitted` defined as first admission of a previously inactive
  unique lane; a same-lane overlap increments only the lane's lease count. Define
  `rejected` narrowly as a new unique lane refused at the 64-lane cap. This intentionally
  removes same-lane reconnects from rejection accounting; no new metric field is added
  because the metric is test-only and no production consumer currently exposes it.

### `tests/session-lane-recall-harness.test.ts`

- Hold a real HTTP request at the mocked upstream boundary, release the manually held
  same-lane lease, and prove the HTTP lease keeps that lane active until its response
  settles. Keep a separate invalid-JSON assertion for the stable downstream 400 envelope.
- Add direct lease assertions proving two same-lane leases share one retained lane and that
  releasing either lease first cannot prematurely free it.
- Add a cross-gate assertion proving 256 active turns on one lane still make the next
  same-lane request fail at the process-wide turn gate.
- Keep the 65th-unique-lane rejection and parent-plus-child lane-isolation coverage.

### This record

- Record the observed production symptom, chosen correction, rejected alternatives, and
  fresh verification evidence. Move the owning unit to `_fin` only if the original #820
  unit is otherwise terminal; this follow-up does not silently close unrelated work.

## Acceptance criteria and activation

| Condition | Activation | Observable proof |
| --- | --- | --- |
| Same-session reconnect | Hold one lease, POST `/v1/responses` with the same `session_id`, and pause the mocked upstream | Releasing the manual lease leaves one active lane until the HTTP response settles; the request returns 200, not admission 503 |
| Same-lane cleanup ordering | Admit two leases for one lane and release them in both orders | Unique active lanes stay 1 until the final release, then become 0 |
| Unique-lane cap | Hold 64 distinct lane leases and request a 65th | 65th returns null and rejection metric increments |
| Global cap with same lane | Hold 256 leases for one lane, then request that lane again | 257th total turn is rejected by the process-wide gate while unique-lane metrics stay bounded |

## Alternatives rejected

- Delete all session-lane accounting: would undo #820's fixed 64-unique-session memory
  envelope.
- Queue same-session retries: adds scheduler state and latency outside this repair.
- Increase the lane cap: does not fix collisions on an already-active logical session.
- Hide the 503 with client retries: preserves the faulty server admission decision and
  creates avoidable reconnect churn.

## Verification policy

- Final verification runs only on the `lidge-ai` SSH host in an isolated checkout. Local
  verification was stopped after the operator clarified this repository's execution policy;
  local results are not PR evidence.
- The remote gate is the focused session/lifecycle slice, full typecheck, full test suite,
  and privacy scan. The PR records only the remote commands and results.
- Test change classification: required behavior regressions only. No assertion, threshold,
  coverage rule, or test is skipped or deleted; the old same-session 503 assertion is
  replaced because that response is the reported defect.
