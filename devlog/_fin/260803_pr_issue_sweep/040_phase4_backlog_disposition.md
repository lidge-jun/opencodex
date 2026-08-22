# 040 — Phase 4: backlog disposition

Twelve standing issues examined against `origin/dev` at `fa51fce541`. The
expectation was that recent merges had quietly fixed several. None had.

| Issue | Verdict | Action | Cost |
|---|---|---|---|
| #907 stale Terra/Luna prices | STILL-REAL | Update metadata, regenerate | S, cross-repo |
| #893 sparse Responses snapshots | STILL-REAL | Narrowed resubmission of #894 | M/L, own unit |
| #888 Kimi K3 image forwarding | STILL-REAL | Closed by Phase 1 (#912) | S |
| #796 Volcengine Ark 400 | NEEDS-INFO | Ask for live Ark result | external |
| #586 no Pool/Direct UI switch | STILL-REAL | Add switch, one surface | S/M |
| #553 Copilot TLS mismatch | ENVIRONMENTAL | Close with explanation | 0 |
| #545 Claude Desktop classifier | STILL-REAL | Needs live OAuth validation | M/H |
| #418 V2 custom→custom delegation | NEEDS-INFO | Ask for current trace | M |
| #241 Desktop model picker | STILL-REAL | Upstream tracker, keep open | external |
| #92 encrypted NEW_TASK | STILL-REAL | Upstream-blocked, keep open | H/external |
| #904 Korean U+FFFD | NEEDS-INFO | Await failing capture | diagnostic |
| #417 voice transcript U+FFFD | STILL-REAL | Upstream tracker, keep open | external |

## The closeable one

**#553** is the only issue that ends this round. The Copilot transport accepts
only HTTPS `*.githubcopilot.com` endpoints
(`src/providers/github-copilot-transport.ts:43`), and PR #575 / commit
`fff8c369f` added TLS-interception identification with an SNI probe
(`src/server/responses/upstream-error.ts:18-25`). The reporter's own evidence
showed a Shadowrocket fake-IP DNS route returning a NetEase certificate, and a
later route returning the correct Copilot certificate. That is interception on
the reporter's machine, not a hostname rewrite in the adapter. The closure says
so plainly and notes that the transport deliberately does not weaken TLS
verification to accommodate it.

## Corrections to record

**#907** — the report is right that Terra and Luna carry pre-price-cut rates.
The bundle at `src/generated/jawcode-model-metadata.ts:47` still has Terra
`2.5/15/0.25/3.125` and Luna `1/6/0.1/1.25`. But the report's claim that cache
writes should be zero is wrong; current published rates
(`input/output/cacheRead/cacheWrite`) are Terra `2/12/0.20/2.50`, Luna
`0.20/1.20/0.02/0.25`, Sol `5/30/0.50/6.25`. The generator source is also
stale, so rerunning `bun run generate:jawcode-metadata` alone reproduces the
defect — the canonical `models.json` in the jawcode source has to move first.
That is a cross-repository step, which is why this is recorded rather than
patched here.

**#796** — the fix may already be present.
`src/adapters/openai-chat.ts:491-515` detects the Ark host and emits a
structured placeholder, called from all three assistant placeholder sites
(`:315`, `:318`, `:347`), and commit `2eebd9268` is an ancestor of `dev`. But
`tests/volcengine-ark-assistant-content.test.ts:16-18` says outright that the
structured empty array is *inferred* and has never been validated against a
live Ark endpoint. Closing on an untested inference would be the exact
evidence failure this unit is trying to avoid. Ask the reporter.

**#418** — not stale and not a duplicate of #92. The V2 model guidance path
still exists (`src/server/responses/collaboration.ts:266-275`). The newest
trace attached to the issue completed on an inherited native model because
`model` was omitted, which is a different failure from the reported
custom-parent → custom-child pairing. One current custom/custom trace settles
which it is.

**#545** — narrower than filed. Gateway-key traffic bypasses native passthrough
and enters translation (`src/server/claude-messages.ts:596-604`), and Anthropic
OAuth always prepends the Claude Code identity
(`src/adapters/anthropic.ts:752-757`). Caller `max_tokens` and stop sequences
are preserved (`:750`, `:764`), so this is not generic parameter loss — it is a
Claude Desktop 3P / Anthropic OAuth compatibility problem. Commit `7fcaa911`
fixed only the false 502 request-log classification, not the repeated
classifier calls.

**#241, #92, #417** stay open as upstream trackers. Routed entries are produced
with `visibility: "list"` (`src/codex/catalog/sync.ts:175-202`); the root
`model_catalog_json` key is written into the Codex config at
`src/codex/inject.ts:430-457` (`:348-357` is only the read/set helper pair —
the original citation here was imprecise and the plan reviewer caught it). The
remaining filter is Desktop's own `available_models` allowlist, which does not
exist in this repository. #92's
ciphertext is opaque to the parser (`src/responses/parser.ts:234-236`) and the
current hardening fails cleanly before routed dispatch
(`src/server/responses/core.ts:1381-1385`) — better diagnosis, still no
plaintext to deliver.

**#904** — no new evidence since filing. The compaction/Kiro surrogate fixes in
#892 (`eeef7a32`) require astral characters at exact chunk boundaries and do
not explain Hangul-only corruption. Hangul sits in the BMP; it survives a
3-byte split differently than a surrogate pair does. Without an
`OCX_LIVE_FRAME_LOG` capture there is no justified repository fix, and guessing
at one would risk changing byte-transparent relay behavior that tests currently
prove correct (`tests/server-live.test.ts:642-675`).

## Plan

1. Close #553 with the environmental explanation and credit for the diagnostic
   evidence the reporter supplied.
2. Close #888 as part of Phase 1.
3. Post evidence comments naming the current code path on #907, #893, #586,
   #545, #241, #92, #417 — each says what is unfixed and where.
4. Post specific information requests on #796, #418, #904 — naming exactly what
   capture or trace would settle it, not a generic "please provide more info".
5. #913 is handled by Phase 3 and gets its closure there.

   **#914 and #919 both stay open.** Four designs across the two were rejected
   at the audit gate, and both moved to
   `devlog/_fin/260803_transport_attribution/`. Their comments record what was
   tried and why each failed, so the next attempt does not rediscover that Bun
   collapses DNS failure and connection refusal into one label, that redirects
   put credential-visible failures on the same path, that a 5xx observed during
   a retry vanishes from the outer catch — or, for #919, that the synthetic 502
   it objects to was introduced deliberately in
   `devlog/_fin/260722_issue_bug_sweep/030_patch_s_sticky_502.md` precisely so
   account health would treat a mid-stream reset as transient. Reversing that
   is a policy call, not a bug fix. Claiming either is fixed here would be the
   overreach the audit prevented.
6. #915 gets an evidence comment recording the fix shape and pointing at its
   own scheduled unit `devlog/_fin/260803_cooldown_recovery_probe/`: it crosses
   routing state, auth resolution, WHAM refresh concurrency, account
   generations, and quota scopes, and needs a generation-fenced background probe
   rather than ordinary account selection. Notably
   `clearCodexAccountCooldown()` must **not** be used — it clears every scope
   and lacks the credential fence.
7. #893's comment points at `devlog/_fin/260803_sparse_snapshot_repair/` for
   the same reason. A deferral that names a unit is a schedule; a deferral that
   names nothing is an issue nobody reopens.

## Accept criteria

- Every issue in the table carries either a closure tied to a commit or a dated
  comment naming a file:line and a verdict — **excluding the two closures this
  phase delegates**: #888 closes in Phase 1 with #912's merge commit, and #913
  closes in Phase 3 with its own. Those two are outside this phase's completion
  gate; if they were inside it, Phase 4 could never reach terminal state before
  Phases 1 and 3, which would make the "phases 1–4 are independent" claim in
  `000_plan.md` false.
- No issue is closed on inference. #796 is the test of this rule.
