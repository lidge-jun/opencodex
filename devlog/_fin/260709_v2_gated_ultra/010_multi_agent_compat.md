# 060 — multi-agent compat: v1 ultra prompt + encrypted-slot sanitizer (260709)

## Findings (live-probed through the proxy, codex-rs source-verified)

1. The multi-agent surface is per THREAD, not per flag. codex-rs resolves it once per
   session: recorded rollout metadata > parent-thread inheritance > model's
   `multi_agent_version` (models.json) > feature flags (core/src/session/turn_context.rs
   721-728, core/src/thread_manager.rs 1177-1220). Upstream pins gpt-5.6-sol/terra to
   "v2" and gpt-5.6-luna to "v1"; everything else follows the flags. v1 threads keep
   working while `multi_agent_v2` is enabled (fork default V1, legacy resume V1), and a
   v2 parent can keep driving a live v1 child via followup_task/send_message.

2. Ultra is a prompt, not a wire effort. `ReasoningEffort::Ultra` flips
   `MultiAgentMode::Proactive` — one developer message
   (core/src/context/multi_agent_mode_instructions.rs) — and converts to `max` at the
   inference boundary. The Proactive fragment is emitted ONLY on the v2 surface.

3. Cross-provider spawn poison: `InterAgentCommunication::new_encrypted`
   (protocol/src/protocol.rs:774) does NO local crypto — it parks plaintext in the
   `encrypted_content` slot and relies on the ChatGPT backend to mint real ciphertext.
   Under a routed (ocx-served) parent the backend never sees the parent turn, so a
   native child replays plaintext in an encrypted slot and the backend kills the stream:
   "Encrypted function output content could not be decrypted or decoded" (observed as
   502 terminal marks + agent error). Routed children are immune (ocx adapters never
   ask the backend to decrypt). Repro: claude parent -> spawn gpt-5.5 = dead; same
   parent -> spawn opencode-go/glm-5.2 = fine.

4. Side quirk: v2 spawn inherits the parent session's base instructions, so a gpt-5.5
   child under a claude parent believes it is claude-fable-5 (visible in usage-debug
   instructions capture). Compat only; not addressed here.

## Shipped (src/server/responses.ts, tests/multi-agent-compat.test.ts)

- `multiAgentGuidanceText`: on a v1-surface turn (tool-shape detection via
  `isV1CollabSurface`: namespaced spawn_agent / send_input / close_agent, flat
  spawn_agent vetoes) arriving at the synthetic top tier (max/ultra) while
  multi_agent_v2 is enabled, inject the verbatim upstream Proactive one-liner wrapped
  in <multi_agent_mode> tags — v1 turns never carry that fragment natively.
- `sanitizeEncryptedContentInPlace`: for native-bound (bare-slug) requests, rewrite
  `{type:"encrypted_content"}` parts whose payload does not look like backend
  ciphertext (base64-ish, >=64 chars) into `{type:"input_text"}`; genuine blobs pass
  byte-identical so replay/cache semantics survive. Verified end-to-end: claude parent
  -> gpt-5.5 child now completes (openai 200s, agent answered).
