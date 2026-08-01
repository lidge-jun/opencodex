# GitHub discoverability — repo topics + local branch alignment

Date: 2026-07-01
Surface: repo metadata (GitHub) + local git state. No source code change.
PABCD: lightweight ops task (P→B→C); no adapter/runtime logic touched.

## Context

A repo evaluation (gajae/architect review, gpt-5.5) flagged that the GitHub
repo had **zero topics**, which hurts discovery for a project pushing the
"use any LLM with Codex" message. The repo already had a strong description
(`Universal provider proxy for OpenAI Codex — use any LLM with Codex CLI, App,
and SDK`) and 207 stars / 15 forks in its first week, so search-surface fixes
are high-leverage for the 1k-star goal.

This entry records three things done together:
1. set GitHub topics,
2. move the local working `HEAD` onto `dev`,
3. log it here.

## What changed

### 1. GitHub topics (was: empty)

Applied via `gh repo edit lidge-jun/opencodex --add-topic ...`. Final set (12):

```
ai-tools, anthropic, claude, codex, codex-cli, developer-tools,
gemini, kiro, llm, openai, proxy, typescript
```

The first 8 (`codex, openai, claude, gemini, llm, proxy, ai-tools, typescript`)
were the explicitly requested set from the review. Added 4 more that match
supported surfaces and common search terms: `anthropic`, `kiro` (both are
first-class adapters), `developer-tools`, and `codex-cli`.

Description and homepage were left as-is (description already strong; homepage
still empty — candidate follow-up: point it at the docs site).

### 2. Local HEAD → dev

The working checkout was on `harden-sources-parse`. Switched to `dev`.

Local `dev` had diverged: 3 local commits (codex-routing/quota WIP at
`f9de872`, `c8630d9`, `9859072`) vs 7 on `origin/dev`. Those 3 were already
upstreamed to `origin/dev` as cherry-picks with different hashes
(`14a1f37`, `c3f1941`, `f945f40`), so `origin/dev` is a strict superset. Reset
local `dev` to `origin/dev` (`f7b7227`) after stashing the old tip on
`backup/dev-prereset-20260701` for safety. No commits were lost.

`origin/dev` tip after alignment: `f7b7227 test(doctor): use
privacy-scan-safe placeholders in doctor fixtures`.

## Verification (fresh evidence)

- `gh repo view lidge-jun/opencodex --json repositoryTopics` →
  `["ai-tools","claude","codex","gemini","llm","openai","proxy","typescript","anthropic","codex-cli","developer-tools","kiro"]`.
- `git branch --show-current` → `dev`; `git log --oneline -1` → `f7b7227`.
- Old local dev tip preserved at `backup/dev-prereset-20260701` (`f9de872`).

## Follow-ups (from the same review, NOT done here)

These are discovery/quality items the review raised; tracked for later, not
part of this entry:
- README: 30s demo GIF at top; a "Why not just OpenRouter?" comparison section.
- Enable GitHub Discussions (Show and tell / Providers / Troubleshooting).
- Set repo homepage to the docs site.
- Two adapter bug candidates to fix first:
  - `src/adapters/anthropic.ts`: `reasoning: "none"` is truthy, can enable
    extended thinking unintentionally.
  - `src/adapters/openai-chat.ts`: stream EOF without `[DONE]` is treated as a
    clean done (should fail-closed against truncation).
- CLI help vs README drift (`ocx login <xai|anthropic|kimi>` vs help text).
