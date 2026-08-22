# 100 — Chat-default regression for Grok 4.5/4.6 (#2227 integration unit)

Audited: 3-round adversarial plan audit (sol-medium), round-3 PASS. Amendment of this
unit's roadmap for the integration merge-train; consumes user directives from 260821.

## Decision

Third-party Responses APIs are supported only as first-class surfaces. Outside OpenAI,
the default wire is `openai-chat`. xAI's own CLI defaults to Chat; its Responses dialect
rejects opaque reasoning continuation/compaction state on later turns (#2240 regression
axis, 4-layer sanitize chase in #2217). Chat translation structurally filters private
extensions instead of chasing them.

- ADOPT #2227: `modelWireDefaults` for grok-4.6/grok-4.5 flip `openai-responses` ->
  `openai-chat` (src/providers/registry.ts:1032/1038 area), structure/04 rewrite, test
  conversions to explicit `modelAdapters` opt-in framing.
- DeepSeek is OUT OF SCOPE (user decision 260821): deepseek-v4-flash/pro keep their
  Responses defaults (registry.ts:1563-1564). Add a focused non-regression test locking
  both V4 entries to `openai-responses` so this train cannot drift them.
- The Responses implementation is NOT deleted; it becomes the opt-in lane (doc 130).

## Atomic merge unit (audit blocker R2-B1)

The #2227 flip and the service_tier policy fix land as ONE merge unit — no intermediate
dev head may exist where OAuth opt-in Responses leaks caller service_tier:

1. Cherry-pick/merge #2227's registry + structure/04 + test changes onto the post-stack
   dev head (anchor: doc 110 global order).
2. In the same unit, fix the fastwire.ts:151 bypass: configured `modelAdapters` must not
   skip the registry OAuth policy. Per audit round-3 note: make the OAuth registry tier
   policy UNCONDITIONAL for the matching xAI route rather than introducing a new config
   field — `modelAdapters` values are wire ids only.
3. Regression matrix locked in tests (5 rows):
   | route | expectation |
   |---|---|
   | OAuth default | chat wire |
   | OAuth explicit Responses (modelAdapters) | responses wire, caller service_tier dropped |
   | API-key default | chat wire; no tier injected; caller service_tier not forwarded unless a capability declares it |
   | API-key explicit Responses (modelAdapters) | responses wire; PRESERVE current dev semantics: absent tier stays absent, caller-supplied service_tier forwards verbatim (resolver proof: forwardCallerTier true on this route today; #2072 deferred) |
   | DeepSeek V4 flash/pro | responses default unchanged |

## Reasoning-streaming proof (#1886 origin)

#1886 moved grok to Responses because Chat translation showed a blank screen during long
reasoning turns. The regression must prove the Chat path now streams reasoning as an E2E
SSE assertion, not unit-only: an early upstream `reasoning_content` delta must be
observed on Codex's reasoning-summary SSE channel BEFORE the completion is released.
Test shape: mock xAI chat stream emitting reasoning_content deltas first; assert the
bridged Responses SSE emits reasoning summary deltas before `response.completed`.
Follow with one live probe through the running proxy.

## Out of scope

- #2072 API-key Fast/priority policy: DEFERRED (open, conflicting, its own review
  cycle). The opt-in switch spec (doc 130) does not depend on it.
- DeepSeek wire changes: none.
