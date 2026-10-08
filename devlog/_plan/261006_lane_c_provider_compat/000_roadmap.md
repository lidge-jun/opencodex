# 000 — Lane C (provider compat) roadmap

Lane session 01a11129 (fork of coordinator 01a11110). Worktree /Users/jun/Developer/new/700_projects/opencodex/.tmp/lanes/sweep-c-providers,
branch codex/sweep-c-providers at origin/dev f494403fba. This unit rides the lane's own PR; the coordinator owns devlog/_plan/261006_compat_hardening_sweep.

| wp | Item | Plan | Exit |
|---|---|---|---|
| wp1 | roadmap | this file | audited, locked |
| wp2 | PR #6657 (luvs01, Devin) | worktree sweep-c-providers-6657 on the PR head; merge origin/dev (no force push); gpt-6.1-sol adversarial review of src/adapters/devin.ts change against tests/providers/devin-chat-wire-fixes.test.ts; fold real defects as commits on the PR branch; bun test focused file, typecheck, structure:check; push; gh pr ready; exact-head CI | READY or NEEDS_HUMAN |
| wp3 | PR #6654 (Ollama, branch on origin) | same shape in sweep-c-providers-6654 with focused commands: bun test tests/providers/ollama/ollama-native-tool-continuations.test.ts tests/providers/ollama/ollama-native-v4.test.ts tests/adapters/abort-race.test.ts; verify initial and rebuild 413, ordinary build error 400, cancellation precedence and zero upstream sends on refusal; also confirm the 413 mapping keeps ordinary build errors at 400 and that docs-site/structure text matches code; shared files structure/transports/responses.md and docs-site reference/adapters.md are B/C shared (second lander reconciles) | READY or NEEDS_HUMAN |
| wp4 | issue #6674 | in the lane worktree: widen qwen38LeadingSystemTemplate in src/adapters/openai-chat/messages.ts from ^(?:Qwen/)? to ^(?:[^/]+/)* so provider-namespaced served ids (openai/Qwen3.8-27B, hosted_vllm/Qwen/Qwen3.8-27B) match while Qwen3.8-27B-FP8 and api.openai.com stay excluded; add positive cases openai/Qwen3.8-27B and hosted_vllm/Qwen/Qwen3.8-27B plus namespaced negative (openai/Qwen3.8-27B-FP8) and native OpenAI control (openai/Qwen3.8-27B on api.openai.com) to tests/adapters/openai/openai-chat-qwen38-leading-system.test.ts; update the owning structure doc if it states the matcher; one PR, Closes #6674 | READY |
| wp4 | issue #6502 | no code change: the report is 2.76.0 and Antigravity effort families were regrouped in 2.77.0 (#6501). resolveAntigravityWireModelId resolves discovery mappings first, aliases second, identity last, so the 404 alone does not tell an endpoint, mapping or account cause apart. Comment asking for a current-version repro with a redacted discovered model list and the resolved wire id; record NEEDS_HUMAN for insufficient evidence | NEEDS_HUMAN |

Verification per PR: focused bun test, bun run typecheck, bun run structure:check, no full local suite (four lanes share this Mac; coverage left to hosted CI), exact-head CI with only path/event-filtered skips.
Bounds: tools gh/git/bun; writes only in the lane write scope plus own registry/structure/docs entries. Branch synchronization (git merge origin/dev into a PR head branch, then push) is lane-owned and granted by the packet; PR integration into dev (gh pr merge) is coordinator-only and never done here.

