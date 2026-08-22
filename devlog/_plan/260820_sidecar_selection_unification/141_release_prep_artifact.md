# 140A — Release prep artifact (next dev release, prepared 260821)

Recommended version: 2.28.0 (feature train on top of 2.27.0; 196+ commits).
Release command (maintainer-controlled): bun scripts/release.ts 2.28.0 --publish
(default is dry-run publish; the workflow bump/commit/push is real either way).

## Release-note skeleton

### Web-search / sidecar unification (#2188, L1-L9)
- Shared sidecar auth slots + unified picker candidates (#2203, #2204).
- Web-search backend registry with executor-runnable candidate sets (#2206).
- (backend, model) pair contract end-to-end: write gates, GUI lists, CLI
  provenance (#2209, #2211).
- Widened backend union openai|anthropic|xai|gemini|exa with capability-gated
  OpenAI field stripping and exaApiKey redaction grammar (#2238).
- Live xAI executor with opt-in x_search (staged PUT validation, byte-bound
  stream cancel) (#2242).
- Live Gemini CCA executor (atomic token/project snapshot, bounded reads) (#2243).
- Exa executor: the first non-LLM search lane (literal-key scrub) (#2245).

### xAI wire policy
- Chat is the OAuth default for grok-4.5/4.6; unconditional OAuth tier policy
  (caller service_tier cannot leak through modelAdapters) (#2255, credits #2227).
- Responses survives as an explicit lane: routed-destination sanitize +
  opaque-state recovery series (#2258, credits #2254's 22-commit series).
- GUI opt-in switch for the Grok Responses lane, atomic dual-entry
  persistence + tri-state read (#2266).
- Post-merge reconciliations: capability-gated external_web_access (#2262,
  caught by the lidge lagging gate), raw-config capability declaration (#2263).

### Fixes
- Continuation bound to the final serving route incl. key-pool rotation (#2214).
- TOML root-boundary lexical scanning preserves commented catalog assignments (#2236).
- Google tool-result adjacency repair (#2207); Claude roster startup sync (#2202).
- OAuth structured-event secret redaction (#2226); affinity diagnostics (#2196).
- Integrations honor OFF with race-free ensure (#2259, credits #2250).
- GUI dropdown opacity (#2253).

### Docs
- Devlog: three-issue round record (#2181), backlog merge log (#2168),
  the 100-150 integration-train roadmap.

## Bug-backlog train additions (260821, second loop)

- #2269 — pool-switch ciphertext stripping locked + null-code encrypted-content
  rejection recovery (fixes #2247).
- #2271 — opencode-go /goal stream drops: namespace-flattening regression locked,
  openaiChatEofTolerance opt-in for complete tool-call EOF (fixes #2260).
- #2246 — google part-field contract enforcement (fixes #2233, maintainer PR
  rebased+landed).
- #2273 — deferred serving-identity commit + passthrough findings (credits #2264).
- #2274 — zcode openai-compatible protocol, prefix-cache restore (credits #2261).
- #2276 — MCode capability sync + writer locking (credits #2220).
- #2277 — Cursor checkpoint reuse, fail-closed explicit refs (credits #2054).
- Superseded/closed: #2267 (by #2262). Deferred to human security review: #2222.
- Issues closed with evidence: #2247 #2260 #2233 #2240 #2188 #2190.

RELEASE STATE: READY, NOT EXECUTED (user directive). One command away:
`bun scripts/release.ts 2.28.0` (dry-run publish) or `--publish` — maintainer's call.

## Gate evidence (doc 150)
- lidge full suite at 6aecc8f15: see /tmp/ocx-gate-final.log (this doc's D attest).
- Local: tsc, oxlint (lint:gui), privacy:scan, build:gui + prepare-package green.
- GitHub Actions on the final dev head: observed at the blocking gate.
- Deferred: #2072 (API-key Fast policy) composes post-train; hygiene-blocked
  drafts (#2222 #2230 #2244) and REVIEW-ONLY items (#2235 #2220 #2215 #2213)
  continue their own cycles.
