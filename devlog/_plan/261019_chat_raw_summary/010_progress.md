# Chat raw reasoning summary compatibility

Target: opt-in verbatim Chat reasoning on the Responses summary channel, leaving defaults unchanged.
Base: origin/dev at implementation start; PR targets dev.

Issue: https://github.com/lidge-jun/opencodex/issues/7367
Draft PR: https://github.com/lidge-jun/opencodex/pull/7370
Branch: codex/chat-raw-reasoning-summary-opt-in

Implementation: default-off per-provider rawReasoningAsSummary; applies only to Responses requests finally routed through openai-chat. Explicit reasoning.summary: none and hideRawReasoning suppress display. Raw text remains in the encrypted reasoning envelope for replay; direct Chat/Messages and native Responses routes stay unchanged.

2026-10-19 verification:
- Bun 1.4.2 focused regression: 9 tests passed, 61 assertions; typecheck passed.
- structure:check, privacy:scan, docs-site frozen install/build passed earlier in this run.
- test:changed did not complete: exited 124 after about ten minutes; captured output ended with Windows temporary-directory cleanup EPERM and had no final test summary. Do not report it as passing.

GitHub status: hygiene and enforce-target are blocked by unsponsored_surface on src/server/auth-cors.ts. MAINTAINERS.md requires maintainer security review and a maintainer-applied maintainer-sponsored label. Keep PR draft; do not apply that label, merge, or deploy. CodeRabbit has not reviewed the draft.

Next: maintainer security review/sponsorship, then address any review findings and refresh CI. No live Codex Desktop rendering was performed; the evidence is the wire-level regression test.
