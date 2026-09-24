# 260924 regression-risk fixes

The 260923 bundle round landed eight lane PRs (#5672-#5685). A post-merge review found four behaviour changes that can silently hurt existing users. The owner asked to fix them directly, merge to dev without waiting for PR CI, and then drive ci.yml lane=all on the dev tip to success.

- 010_wsl_home.md — WSL Codex home switch (#5441 carry).
- 020_windows_mise_node.md — Windows npm global under mise-managed Node refused (#5316 carry).
- 030_echo_filter.md — tool-envelope echo filter truncates ordinary answers (#5098 carry).
- 040_tool_call_hold.md — unbounded hold of an unmatched bare <tool_call> block (#5548 carry).
- 050_delivery.md — branch, merge and dev CI.

Accepted and out of scope: Claude Code <=2.1.222 picker filter (/^(claude|anthropic)/i) drops ocx-claude-* ids; other residual risks are documented in the round's landing log only.


Cycle note: wp1's first close attempt failed on a malformed receipt command and the cycle was re-walked with the same artifacts.
