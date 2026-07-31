# 000 — Community PR Triage & Absorption Roadmap

## Objective
Triage 6 community PRs, absorb valuable ones onto dev with blocker fixes, close the rest.

## Loop-spec
- Loop archetype: verifier-defined (tests pass per absorption)
- Write scope: dev branch, src/ and tests/ only
- Out of scope: PR #187, #188, #169, #150
- Budget: process as many as context allows

## Triage decisions (based on sol adversarial review)

| PR | Decision | Rationale | Complexity |
|----|----------|-----------|------------|
| #197 qwen3.8 reasoning | ABSORB | Correct model ID, needs preserve_thinking wire flag investigation | C1 |
| #193 port pinning | ABSORB | Real issue #152, needs port=0 fix | C2 |
| #195 GUI request logs | ABSORB | Real UX problem, needs redaction + tail fix | C2 |
| #191 Cloudflare Workers AI | ABSORB | New provider, needs template fix + model refresh | C2 |
| #194 sticky pool rebind | CLOSE | Fundamental design flaws: non-transient→soft-avoid, late affinity race. Concept good but needs full rework | C3+ |
| #192 cursor tool budget | CLOSE | 3 fundamental flaws: byte estimation, cap bypass, tool recovery. Needs architecture rethink | C3+ |

## Work-phase map

| WP | Slice | Files | Depends on |
|----|-------|-------|------------|
| WP0 | This triage doc (docs-only) | devlog/ | — |
| WP1 | #197 qwen3.8 reasoning | registry.ts, openai-chat.ts, tests/ | WP0 |
| WP2 | #193 port pinning | bin/ocx.mjs, src/cli/*.ts, src/server/ports.ts | WP0 |
| WP3 | #195 GUI request logs | src/server/request-log.ts, src/usage/log.ts, src/server/index.ts | WP0 |
| WP4 | #191 Cloudflare Workers AI | registry.ts, src/cli/init.ts, src/oauth/login-cli.ts, gui/ | WP1 (registry.ts) |
| WP5 | #194 close | — (comment only) | WP0 |
| WP6 | #192 close | — (comment only) | WP0 |

## Accept criteria
1. Each ABSORB PR: commit on dev, tests pass, pushed, PR closed with credit
2. Each CLOSE PR: PR closed with explanation and recognition of concept value
