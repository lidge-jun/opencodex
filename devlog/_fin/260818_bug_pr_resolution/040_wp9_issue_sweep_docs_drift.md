# 040 — WP9: resolved-issue sweep + structure/04 drift disposition

## Part 1 — structure/04 drift line

Recorded finding (devlog/_fin/260818_release_readiness_2260/010:50): "structure/04
claims chat passthrough emits service_tier by default — docs drift, needs a line fix."

Current-state verdict (CORRECTED per r6 audit): no historical revision of
structure/04 ever said "emits by default" verbatim, and B1 did NOT fix the
drift — B1 INTRODUCED it. The release-readiness auditor recorded the finding
against the post-B1 doc; the finding IS the B1-added clause at structure/04:663
("canonical Fast follows the resolved Fast policy and does not require
chatServiceTier"), which sits in the NATIVE chat passthrough paragraph.
Code: buildOpenAIChatPassthroughRequest (openai-chat.ts:121) forwards
service_tier only when provider.chatServiceTier is set.

r6 verified verdict (F2, HIGH): structure/04:663 is FALSE for the native path.
A classified Fast-capable route CAN reach the native passthrough
(isNativeChatRouteEligible excludes only combo/policy/auth/store/hosted-tools,
chat-native.ts:54-72), and on that path NO canonical Fast injection happens:
no decideTier/tierDecision/canonicalToWire/fastMode wiring exists in
chat-native.ts — tier resolution lives only in the Responses pipeline
(core.ts:1206) feeding adapter buildRequest (openai-chat.ts:1304-1313), which
the passthrough bypasses. Caller canonical "fast"/"priority" is DROPPED without
chatServiceTier:true and forwarded RAW (never wire-mapped) with it; fastMode
injects nothing. The sentence is true only for the bridged
Chat->Responses->Chat path. B fix: rewrite the :663 clause to scope canonical
Fast policy to the bridged path and state the native passthrough's actual
contract (chatServiceTier-gated raw forwarding, no injection). Docs-only
commit to dev.

## Part 2 — resolved-issue sweep

Sweep the ~50 open issues for ones already resolved by merges on dev
(campaign rule: PRs target dev, no auto-close). Method: 2 parallel read-only
subagent lanes over the open-issue list, each issue judged against origin/dev
code with commit evidence; close only issues whose fix is verifiably on dev
(cite SHA + file:line), comment-with-evidence per close. Known candidates from
the campaign: #1938-class already handled; check #1939 (ownership sync error),
#1924 (OpenCode Go quota gate), #1927 (MiMo vision bypass), #1866 (closed in
wp6), #1852 (stays open pending #1876), plus anything the lanes find.
Judgment rule: ambiguous = leave open with a status comment only if evidence is
strong; never close on inference.

## Verifiers

- Docs commit: docs-only diff (git show --stat), pushed to dev directly
  (docs-only, campaign pre-approval) or via PR if any src/ file is touched.
- Issue closes: gh issue view state transitions with evidence comments.
- bun run typecheck only if any src change (not expected).

IN: doc line fix + evidence-based issue closes. OUT: any code behavior change.
