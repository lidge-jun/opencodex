# 003 — WP2 plan: devlog closeout + issue #126 reply + push

## Tasks
1. Draft English follow-up comment for issue #126 (owner account):
   - 3-branch root cause (404 = NIM account/rollout listing≠invocable; 400 = param incompatibilities incl. kimi single-tool-call + reasoning_effort; hangs = free-tier throttling/queueing).
   - State what we patched on `dev` (parallel_tool_calls:false for nvidia, reasoning_effort suppression for NIM kimi family, upstream error detail surfacing) and that a **release is still pending** — user must wait for the next version (and restart `ocx`), and some causes (NIM account enablement, free-tier capacity) are outside the proxy's control.
   - Practical workarounds now: try `moonshotai/kimi-k2-instruct`-class smaller models, disable web search toggle to simplify the path, expect free-tier slowness.
2. Commit ONLY: src/providers/registry.ts, src/adapters/openai-chat.ts, tests/nvidia-nim-hardening.test.ts, devlog/_plan/260715_issue126_nim_kimi/*.
3. Push origin/dev (4 pre-existing cursor commits ride along — they are already on dev). No release/tag.

## Verification
- gh comment URL returned; `git log origin/dev -1` shows the new commit after push; `git status` still shows parallel agents' dirty files untouched.
