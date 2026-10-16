# 260914 — Carry contributor PR #4528

## Why a carry

PR #4528 (branch fix/codex-forward-user-4527, head d1d8d45f22c8, author RHODIZSECURITY)
fixes issue #4527. It was stuck for reasons unrelated to its code: a contributor draft
whose four-box readiness checklist resets on every push, and a Cross-platform CI run
(34774339026) that failed on exactly one test, "release version line > the in-tree
version is never behind a released one".

That failure is stale base, not a defect. The test compares package.json against the
highest local release tag. The branch sat at in-tree 2.54.0 while v2.54.0 was already
tagged, so ordering === 0 and the tag does not point at the branch head. dev has since
opened 2.55.0 against a highest tag of v2.54.0, so the same test passes on a fresh base.

## Defect being fixed

Claude Code sends metadata.user_id; src/claude/inbound.ts maps it onto the Responses
top-level user field. src/adapters/openai-responses.ts stripped other unsupported
native-forward fields but left that one on the canonical ChatGPT Codex wire, which
rejects it with 400 "Unsupported parameter: user". Because a generic 400 was terminal
for a combo, a request that had already taken a 429 on an earlier target ended the turn
rather than trying the next healthy one.

## Scope boundary

Only a clear pre-output, target-local incompatibility may fall through to the next
target. Widening this to retry all 400s would be a defect, not an improvement.
Cancellation, policy refusals, context overflow, other invalid requests and anything
after output commitment must stay terminal.

## Proof policy

Local product suite, typecheck, build and install are NOT RUN. Focused runs are
debugging only and are never cited. The only proof is hosted Cross-platform CI at the
exact final head SHA.
