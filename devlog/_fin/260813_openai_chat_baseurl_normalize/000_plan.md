# 260813_openai_chat_baseurl_normalize — openai-chat baseUrl endpoint paste compatibility

## Objective

Custom openai-chat providers must accept the four common paste shapes and still POST the canonical Chat Completions URL:

- https://host/v1
- https://host/v1/
- https://host/v1/chat/completions
- https://host/v1/chat/completions/

Target constructed URL in every case: https://host/v1/chat/completions (no doubled path, no trailing slash).

Live Teamwicked proof (2026-08-13, local ocx 2.13.0):

| Configured / probed URL | Result |
| --- | --- |
| https://api.teamwicked.me/v1/chat/completions as baseUrl | OCX sent /v1/chat/completions/chat/completions; 6/6 http_404 including ocx-msqzl901-69 |
| https://api.teamwicked.me/v1/ as baseUrl | OCX sent /v1/chat/completions/; Teamwicked teamwicked_gateway_error 404 |
| Direct POST https://api.teamwicked.me/v1/chat/completions | 200, model kimi-k3 |
| Direct POST https://api.teamwicked.me/v1/chat/completions/ | 404 teamwicked_gateway_error |
| OCX after baseUrl=https://api.teamwicked.me/v1 | /v1/chat/completions 200 OK; /v1/responses 200 OK; /models 5 models |

Issue #1582 already records the doubled-path case. This unit also records the trailing-slash case and lands the adapter fix.

## Loop-spec

- Loop archetype: spec-satisfaction repair
- Trigger: custom openai-chat baseUrl already contains /chat/completions and/or a trailing slash
- Goal: those pastes become the same canonical POST URL
- Non-goals: Teamwicked preset, dashboard redesign, rewriting other adapters, touching dirty main/dev checkouts
- Verifier: focused bun test asserting the four shapes plus issue comment plus --no-verify push
- Stop: green focused tests + issue comment URL + push output
- Memory: this unit + goalplan normalize-custom-openai-chat-provider-baseurl-so
- Terminal: DONE / NOOP / BLOCKED / UNSAFE / NEEDS_HUMAN / BUDGET_EXHAUSTED as in the host goal
- Escalation: three failed repairs return to P; do not reset unrelated worktrees

## Dependency-ordered work-phase map

1. wp-0 (this cycle, docs-only): lock research + the implementation decade doc.
2. wp-1 (010_normalize_chat_baseurl.md): isolated worktree off origin/dev, implement helper + tests, comment #1582, commit, push --no-verify.

No effort buckets. Implementation cannot start until this docs cycle closes.

## GitHub / local pattern search (wp-0 evidence)

Local owners already use trailing-anchor regex, not string concat:

- tests/url-normalization.test.ts anthropic helper: baseUrl.replace(/\\/v1\\/?$/, "") then append /v1/messages. Covers /v1 and /v1/, refuses mid-path /v1, refuses somev1.
- src/adapters/openai-responses.ts key-auth branch: provider.baseUrl.replace(/\\/v1\\/?$/, "") then /v1/responses. Optional responsesPath uses replace(/\\/$/, "") only.
- src/server/images.ts keyed images: same /\\/v1\\/?$/ strip before /v1/images/...
- src/providers/base-url-choices.ts: baseUrl.trim().replace(/\\/+$/, "") for choice matching.
- src/adapters/openai-chat.ts:978 is the defect: template literal provider.baseUrl + /chat/completions with no strip.

GitHub code search in lidge-jun/opencodex for normalizeBaseUrl chat/completions baseUrl replace trailing slash openai-chat returned no additional owner. Reuse the existing trailing-anchor regex family rather than invent a third helper module.

## IN / OUT

IN:

- isolated worktree from origin/dev
- export a regex helper next to the openai-chat adapter
- src/adapters/openai-chat.ts buildRequest URL line
- focused tests for the four paste shapes plus mid-path / suffix-false-positive guards
- #1582 comment with trailing-slash live proof (no secrets)
- commit + git push --no-verify

OUT:

- Teamwicked registry preset
- rewriting anthropic/responses/images unless a one-line shared helper is already the owner
- dashboard form redesign
- git reset / rebase of busy dev or dirty main
- force-push

## Risks

- Gateways whose real chat path is not /chat/completions (already out of contract; keep appending that leaf after strip).
- A host whose pathname legitimately ends with /chat/completions-foo must not be stripped.
- Discovery (${baseUrl}/models) is a separate join; this unit only changes the chat send URL.

## Activation scenarios

- doubled path: baseUrl ends with /chat/completions -> constructed URL must not contain /chat/completions/chat/completions
- trailing slash: baseUrl ends with / -> constructed URL must not end with /chat/completions/
- canonical /v1: unchanged
- mid-path /v1/relay: still appends /chat/completions
