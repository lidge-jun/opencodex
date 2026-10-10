# Phase 3 — Codex App and provider issue disposition

Dependency: both selected code PRs merged. This is an issue-analysis and comment phase. It changes no runtime source, listener policy, or installed Codex app. Recheck current `origin/dev`, each issue's newest comment and the merged Images behavior before posting. Comments must be in English, cite code or merged PRs, and never request a body, token, query secret or account identifier.

## Exact external write map

| Issue | Action | Before → after |
| --- | --- | --- |
| #4213 | Recheck the initial comment posted after `wp1`; ADD a correction only if fresh evidence arrives; keep open | Current issue has a bypass report but no failing Astra method/path/status. The initial comment separates the known `/v1/images/generations` admission/config branch from an unverified app trial path, links the merged Pool Images fix if relevant, and gives a concrete diagnostic capture plan. Do not claim the trial prompt fixed or widen `/v1/*` on inference. |
| #4143 | ADD a comment; keep open unless a current fixture proves resolution | Old 2.49 Linux Desktop-only Terra screenshot becomes an explicit request for current version, catalog generation and suppression facts. Current native roster already contains Terra; do not call that proof the user's app picker is repaired. |
| #3506 | Existing owner comment explains client-owned tool continuation. Keep open; add a train-4 note only if new evidence changes the contract. | No proxy one-request timeout is proposed for a cross-request no-progress trajectory. |
| #3765 | ADD a comment; keep open | Request a redacted stable-prefix warm/cold comparison and clarify that cache counters alone do not show where the prefix changed. |
| #5270 | Existing owner comment records intentional tools-disabled Qoder adapter. Keep open; add a train-4 note only if the other lane lands a relevant client integration. | Adapter tool-call bridge requires versioned Qoder intent and call-ID continuation fixture; client integration remains outside this lane. |
| #2511 | ADD a design-only comment if the issue lacks a current scoped decision; keep open | Current refusal guard is distinct from the requested automatic image mutation. Record a deterministic proposed downscale→prune policy and the unresolved input-loss choice. |

## #4213 causal boundary and discriminating capture

Known: the fixed loopback allowlist in `src/server/index.ts:402-430` admits `POST /v1/images/generations`, and `src/server/images.ts:678-690` returns a configuration 400 when no capable OpenAI/CCA path is usable. The default-deny handler in `src/server/index/serve-options.ts:316-320` answers an unknown path with 404. None is a captured failing Astra-trial request. Hypotheses and falsifiers:

1. An app trial/entitlement call reaches a non-allowlisted `/v1` path and gets 404. Falsifier: the sanitized failing call is allowed or never reaches the proxy.
2. The trial prompt is gated by app/account state independent of a proxied inference endpoint; the restart in the report changes that state. Falsifier: same app/account session shows a deterministic proxy-visible failing method/path/status when only the endpoint changes.
3. The image tool reaches Images but has no capable authenticated upstream. Falsifier: response is not that handler's 400, or a capable upstream is proven present and the failure is elsewhere.

The route/auth contract needed to proxy any new native app surface is unknown. Ask for separate sanitized `method + path + status` records for trial and image symptoms, exact OCX/App versions, a yes/no about a capable image upstream, and whether the Images request used proxy admission auth or a direct ChatGPT bearer (category only, no value or account identifier). If the image status is 400, first determine which Images branch returned it; if 401/403, inspect admission/auth policy; if 404, identify exact path; if 2xx but app still fails, inspect response shape without prompt content. A new path needs documented upstream destination, credential owner, and negative fixtures before allowlisting. This is a concrete plan and a statement of what is known, not an invented root cause.

## #2511 design decision only

The existing opt-in `maxUpstreamBodyBytes` checks the final serialized outbound request in `src/server/responses/outbound-body-guard.ts:67-89`; leave its refusal behavior intact. A future remediation could run only after routing selects the provider and before each physical send: measure the *actual* serialized body; if over limit, downscale eligible inline images one by one using deterministic quality steps and reserialize; if still over, prune oldest eligible image parts while preserving the newest user turn and every non-image text/tool/call-ID relation; reserialize and stop when under budget. If preserving those invariants cannot fit, return the current bounded error. Repeat measurement for retries and adapters that rebuild wire bodies. Do not log or persist original/resized bytes or content-derived tags. Unknowns that block code: whether the user has approved lossy image mutation, which image encodings can be safely rewritten, order among multiple images in one turn, and whether tool-result images can be removed without breaking call pairing. Resolve these in the issue before implementation.

## Verification

For each posted comment, read it back from GitHub and confirm number, body, open/closed state and link. A current source/merged-commit link is needed for any claim of resolution. For #4213 and #4143, no local user's app configuration is changed. If the diagnostic records arrive during this phase, amend this doc, run a separate repair cycle if a bounded regression is feasible, and update the issue with verified evidence.

## wp3 result (2026-09-28)

- #4213: diagnostic comment posted ([issuecomment-5857691131](https://github.com/lidge-jun/opencodex/issues/4213#issuecomment-5857691131)). It separates image-tool gating (client side: plan, feature flag, auth mode, model input modalities) from a failed Images call, links #6097 for the Pool admission failure, and names the trial-prompt cause: the live roster's `availability_nux` is dropped by `parseAccountModels`, so native rows keep the pinned `null`. The fix is `wp5` (`050_trial_nux.md`). Stays open.
- #4143: current-build reproduction request posted ([issuecomment-5857853055](https://github.com/lidge-jun/opencodex/issues/4143#issuecomment-5857853055)); stays open.
- #3765: `OPENCODEX_CACHE_DEBUG=1` two-turn comparison request posted ([issuecomment-5857853190](https://github.com/lidge-jun/opencodex/issues/3765#issuecomment-5857853190)); stays open.
- #2511, #3506, #5270: no new comment. An independent sol audit found the drafts repeated or contradicted the existing maintainer comments, and the posting conditions above (no current scoped decision / new evidence / landed Qoder client integration) are not met. The existing maintainer comments remain the recorded disposition; all three stay open.
