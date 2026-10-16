# Realtime voice: sideband joins for calls opencodex did not create

ChatGPT voice ("GPT Live") can now hand a call to a Codex thread on the user's Mac: the ChatGPT client creates the WebRTC call with its own ChatGPT login, and the local Codex app-server joins the call's control sideband (`V3`, `transport=ExistingCall`). With opencodex injected, that join arrives at `ws://127.0.0.1:<port>/v1/live/<call_id>`, and opencodex re-authenticates it with whichever Pool account it selects. The join therefore reaches the upstream as an account other than the caller that started the call, and Codex reports `502 Bad Gateway: realtime websocket handshake failed` after five attempts. The credential overwrite is confirmed in source and in the user's ledger; that the upstream refused the join because of the account (rather than another handshake fault) is a strong inference, because Bun hides the upstream handshake status.

- Archetype: satisfy-spec (compatibility with the current Codex/ChatGPT voice clients).
- Trigger: user report on 2026-10-06 that live voice through opencodex stopped working after the Codex/ChatGPT update.
- Class: C3 relay repair with C4 care, because it changes which credential a sideband join carries.
- Goal: one ordinary PR to `dev` so a native sideband join for a call opencodex did not create is authenticated as the caller that owns it, while joins for calls opencodex created keep the existing Pool account continuity.
- Non-goals: GPT-Live public `/v1/live/sessions` API family, external audio-key aliases, Codex config injection for the provider-table mode, merge, release, restarting the user's proxy, live paid probes.
- Verifier: focused regression tests for the new join decision and the call registry, the unchanged #35830 continuity test, and the existing scope/external-audio/layout/ratchet/structure/privacy/Lab gates, all run by hosted CI only. Explicit security review is required (credential handling, `MAINTAINERS.md`). The user instructed no local test runs ("로컬 테스트 하지 말고"); typecheck, suite, lint and build are left to exact-head CI and named as not run locally.
- Stop: PR open against `dev`, exact-head CI inspected, independent review findings folded.
- Artifacts: `.tmp/realtime-investigation/` (ignored) holds the seven investigation reports; Aside's public-web report is under the Aside account artifact directory.
- Resources: this worktree, git/gh for this branch, gpt-6.1-sol leaves, Aside exec for public research. No token or wall-clock budget was set by the user.

## Evidence

Runtime (read-only, identifiers omitted): Codex `logs_2.sqlite` shows four `RealtimeConversationStart` operations with `version=V3; transport=ExistingCall; output_modality=Audio` from `codex_chatgpt_ios_remote` 1.2026.266 (2026-10-03, three sessions) and 1.2026.267 (2026-10-05, one session). Each dialed `/v1/live/<call-id>` on the loopback proxy five times and failed with 502. opencodex `usage.jsonl` holds the matching twenty `gpt-live` rows (`upstream_server_error`, `failureStage=headers-only`).

The account labels on those rows differ: the last voice session that completed its handshake (2026-09-30, create 201 then join 101; audibility not recorded) ran on one Pool account for both legs, the 2026-10-03 joins on a second account and the 2026-10-05 joins on a third. The configured Pool holds five ChatGPT accounts. A local sanitized comparison (booleans only, no identifiers printed) found that none of the five Pool credentials carries the ChatGPT account id of the Codex login on this Mac, which is the credential Codex attaches to an ExistingCall join; both accounts used for the failing joins are non-main Pool accounts.

Source: `resolveLiveRelay` (`src/server/live.ts`) resolves every native join through `resolveFirstUsableOpenAiSidecar`, which in Pool mode selects by Pool policy and thread affinity and replaces the caller's `authorization`/`chatgpt-account-id`. Continuity for calls opencodex created is carried only by thread affinity (`tests/server/server-live.test.ts`, "call-create and its sideband join bind to the same pool account (openai/codex #35830)"). Nothing records which calls opencodex created, so an externally created call is joined under an unrelated account. Upstream Codex attaches its own configured-provider ChatGPT auth to the ExistingCall join (`codex-rs/core/src/realtime_conversation.rs` ExistingCall branch; `client.rs` `current_client_setup`), which is the account that owns the call.

The rest of the Codex 6cfe29984..41acdad24 realtime range is transparent to opencodex; see `010_incompatibility_matrix.md`.

## Work phases

1. wp1 (this document set): investigation and roadmap, docs only.
2. wp2: implement `020_existing_call_join.md`, add the regression test, update the owning structure doc, publish the PR, inspect exact-head CI.
