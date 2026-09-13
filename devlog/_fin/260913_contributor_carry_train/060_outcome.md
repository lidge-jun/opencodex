# Outcome — the contributor carry train

Twelve lanes were dispatched to land the open contributor work scored 60 or
higher. Eleven landed and one needed nothing, because the work it was sent to carry was
already on dev.

## What landed

| Wave | Lane | Tip | Merge commit | Carried |
| --- | --- | --- | --- | --- |
| 1 | L | #4481 | d865aacf93 | #4382 luvs01, #4413 rrmlima |
| 1 | B | #4480 | 2af30c2d0e | #4381 luvs01, #4388 luvs01, #4460 AgenticLab-SH |
| 1 | X | #4474 | 2296e485d6 | #4077 laerad777, copy residue only |
| 1 | I1 | #4486 | a3ca64f605 | issues #4425, #4442 |
| 1 | I2 | #4482 | 990cd8cce5 | issues #4430, #4435 |
| 1 | C | #4487 | 55bb9f3fef | #4438 Yongzhaooo, #4389 olddonkey, #4457 jeongjin0 |
| 1 | R | #4489 | 3f76ce415d | #4455 jeongjin0, #4409 yxr1995-maker, #4387 luvs01 |
| 1 | S | #4477 | 981b53e7d0 | #4447 Veritas-7 |
| 2 | I3 | #4500 | 94063d0798 | #4467 jaychou0642-create, issue #3775 |
| 2 | I4 | #4498 | 8e6c99608c | issue #4454 |
| 2 | H | — | — | nothing to carry; #3663 was already on dev |
| 2 | I5 | #4515 | cb2e15ba6f | issue #4429, scoped slice |

Every merge used the same gate: a Cross-platform CI run concluded success on the
exact tip head SHA, the merge commit was verified with
`git merge-base --is-ancestor` against `origin/dev` afterwards, and the
`Co-authored-by` trailers were read out of the landed commits rather than the
pull request bodies.

## Dispositions

Closed with evidence naming the landing and merge commit: source pull requests
#4382, #4413, #4170, #4381, #4388, #4460, #4077, #4438, #4389, #4457, #4455,
#4409, #4387, #4171, #4086, #4465, #4467, #3663, #4447, plus the carry links
GitHub did not auto-close (#4479, #4473, #4485). Issues #4425, #4442, #4430,
#4435, #4439, #4456, #4412, #3729, #4436, #3775 and #4454 were closed the same
way.

Nine further contributor pull requests were closed before the train started,
because the previous 36-PR batch had already absorbed them: #4319, #4310, #3652,
#4229, #4216, #4119, #4317, #4080 and #3458.

Six issues stay open with a status comment naming what landed and what remains:
#4191, #4311, #3661, #3781, #4312 and #3506. Each one has merged work that
references it and no merged work that closes it, which is the distinction the
previous batch learned to make.

## What the reviews caught

Every audit round in this train found something real, which is the argument for
running them rather than trusting a green tip.

The roadmap itself failed its first audit on five blockers, including two lanes
prepared as peers that both write `src/server/responses/core.ts`, and a lane
claiming a Windows CI leg that only runs on `workflow_dispatch`.

The dispatch packets failed their first audit on five more. The severe one was
an unqualified "never merge" in the common frame, which would have stopped every
lane from running the `git merge origin/dev` the roadmap requires at a drifted
tip. Another would have had lane X cherry-pick a commit that re-breaks an
evidence-based model exclusion.

Lane S took two security rounds. The first found that the canonical OpenAI seed
defines only four keys, so "ignore keys the seed never defines" reached `headers`
— which the PATCH mask writes and the forward adapter applies to the upstream
ChatGPT request ahead of incoming headers. A dashboard-session PATCH would have
ridden every later request.

Lane I4 took three. Rounds one and two each found the same defect wearing a
different payload: combo children bypassed the repair on their own cloned body,
and the matcher required a well-formed Fernet token so near-miss ciphertext fell
straight back into the original path. Round two then found the fix had traded
fail-open for data loss — `looksLikeBackendCiphertext` is length ≥ 64 over a
character class that a SHA-256 digest matches exactly. The landed version keeps
the two slot kinds asymmetric: an `encrypted_content` slot is stripped whatever
it holds, free text is matched strictly.

## The lesson that repeated

Three planned carries turned out to be already satisfied on dev: #4170 in lane L,
#4086 in lane R, and the whole of lane H. All three were found by attempting the
work, not by reading the plan.

The inverse happened twice. #4465 proposed the #4442 fix before lane I1 existed
and was not in the scored inventory, because the inventory is a snapshot taken
before it was opened; the landing carries a trailer for its author. #4467 was
caught the same way, but at dispatch time rather than after the fact, because the
first incident turned into a standing check.

Both directions are the same defect in the plan, not in the lanes: a snapshot of
the open queue is stale the moment it is taken, and only the lane touching the
code can tell.

## The lane that did not close its issue

Lane I5 is the one outcome in this train that is deliberately partial, and it is
the better result.

Issue #4429 reads as a missing executor: a key-auth gateway echoes hosted web_search as
a client function_call, and webSearchBridge had an executor only for ollama.
Arming the other five backends is what #4515 landed. It does not fix the reported
failure, and the lane said so rather than closing the issue.

The reporter's own probe is why. It ends with two pending client calls, exec and
web_search, which the bridge refuses with web_search_bridge_mixed_tools. The
boundary is the mixed-tool leg, not the missing backend, so a continuation has to
preserve the client's exec call and call_id and their ordering without executing
it proxy-side and without losing hosted-search items the relay already completed.
The issue stays open for that, with the scoping recorded on it.

The DeepSeek case in the same thread stays separate on purpose: it emits no
function calls at all, only assistant text, and making matching prose executable
would turn model output into tool execution.

A scoped slice with an accurate description is what the packet asked for, and
refusing to close the issue is the part that makes it honest.

## Final integration evidence

Cross-platform CI run [34760250023](https://github.com/lidge-jun/opencodex/actions/runs/34760250023)
completed successfully on `cb2e15ba6f8ac17af0620d6ff04fcfa7d88e3dcd`, the
merge commit for the last implementation PR, #4515. This verifies the integrated
batch; conditional jobs remain skips rather than claimed passes.

Issue #4429 remains partially unresolved: the non-Ollama executor slice landed, while
mixed-tool continuation remains open. Issue #4519 separately tracks the Ollama endpoint destination-policy gap; it is not the mixed-tool continuation tracker.

## Honest limits of the proof

Non-tip pull requests merged without their own `ci` check, under the recorded
owner authorization for tip-only CI. What makes that defensible is that each lane
is cumulative, so the content of every link is a strict subset of what its tip's
green run executed; the evidence exists, attached to the tip.

No local full test suite was run at any point. Every suite claim traces to a
hosted run id.

Most `dev` runs triggered mid-batch ended `cancelled` as the next merge
superseded them inside the concurrency group. That is the workflow behaving as
configured, and the regression evidence is the completed runs on batch-containing
commits rather than those cancelled ones.

## LOOP-PESSIMIST-01: what did not improve

The hypothesis that died is that a scored inventory plus a written roadmap is
enough to dispatch from. It was wrong twice in each direction, and the correction
was not a better inventory — it was giving every lane the obligation to
re-verify its own inputs before writing code.

What did not improve is lane-thread observability. `list_threads` is capped at
50 and the newest lane tasks fell outside it repeatedly, so reaching a lane
required reading session files off disk to recover its thread id. Coordination
worked anyway, but it worked around the tool rather than through it.

What would show the tip-only CI economy is the wrong trade: a defect landing on
`dev` that a per-link run would have caught and the cumulative tip run did not.
No instance appeared in this batch or the previous one. That is not proof it
cannot happen — a lane whose links conflict semantically rather than textually
could still produce one — and it is the specific thing to watch for.
