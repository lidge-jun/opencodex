# 000 — Plan: Generous image pipeline (Anthropic adapter)

## Objective

Replace "drop oldest images" with "degrade gracefully": any real-world image, any size
(extreme values excluded), gets normalized at the proxy so Anthropic accepts it — resized
and re-encoded per an age-tier pyramid instead of textified. Textify becomes the last
resort (undecodable input, extreme values, Anthropic 100-image hard cap).

## Constraints

- Runtime: bun 1.3.14 pinned (`package.json` engines/packageManager). `Bun.Image` verified
  present (`typeof Bun.Image === "function"`, probed 2026-07-14). Zero new native deps
  preferred; sharp (official Bun support) is the recorded fallback if the wp3 probe finds
  coverage gaps.
- The 5MB per-image API limit is measured on the BASE64 STRING LENGTH, not decoded bytes
  (Claude Code `apiLimits.ts`, verified against Anthropic internal API source — see
  001_prior_art.md). All byte math in this unit uses base64-length units.
- Anthropic server-side resizes >1568px anyway; nothing above ~2000px carries value.
- Proxy must not change conversation semantics (no summarization — that is the client's
  job); visual degradation of old images is acceptable, silent content rewriting is not.
- Normalization must be deterministic per (image, tier) so repeated turns emit identical
  bytes (prompt-cache friendliness) — enforced via content-hash cache.

## Dependency-ordered phase map

| Phase | Doc | Depends on | Delivers |
|-------|-----|-----------|----------|
| wp1 | this + 001 | — | Research record + this roadmap (doc-only Phase-0) |
| wp2 | 010 | wp1 | Correct units: Rule 1b compares base64 length (foundation for all later byte math) |
| wp3 | 020 | wp2 | Normalization pipeline: tier pyramid + cache + guards (consumes wp2's correct units) |
| wp4 | 030 | wp3 | Upstream-413 tightened-retry (consumes wp3's tier machinery) |

## Verifier

Per code phase: targeted activation-grounded tests + `bun test --isolate ./tests/` +
`bun x tsc --noEmit`, all fresh, exit 0. Reviewer verdict (sol subagent when dispatch
survives proxy churn; direct independent audit otherwise) recorded per phase.

## SoT sync target

No repo-wide architecture doc exists for adapters; the adapter-local rationale comments in
`anthropic-image-guard.ts` + this unit are the SoT. D of wp3 revisits whether a
`src/adapters/README` pointer is warranted.

## Audit round 1 (sol reviewer Galileo, FAIL, blockers=6) — synthesis

All six accepted and folded: (1) async buildRequest test-caller migration added to 020;
(2) cache re-specified as byte-weighted LRU, 64MiB aggregate cap; (3) behavior contract
re-designed — hard per-tier caps + aggregate demotion loop to floor (500px/q40/100KiB),
textify only past all-floor overflow (≈180+ images), 100-image zero-textify activation
test added; (4) 030 re-specified with single mutable activeAdapter + explicit
429/413 retry-state transitions; (5) guard header rationale rewrite added to 020;
(6) cache test upgraded to encoder-seam call counting. Reviewer also positively verified:
010 arithmetic, alias compatibility, export feasibility, in-place mutation safety,
IncomingMeta additivity, image detectability from parsed.context.messages, LEXICO-SPLIT.

## Audit round 2 (same reviewer, FAIL, blockers=5) — synthesis

All five accepted and folded: (1) deterministic terminating ladder at floor
(500px/q40 → 400px/q30 → 320px/q25 terminal, measured-size accounting, honest
zero-textify claim + noise-fixture termination test N7); (2) decode-failure contract —
corrupt/undecodable payloads textify with a distinct note (pass-through exemption only
for valid sniffed animations within caps); (3) request-scoped currentImageTierBias read
by every rebuild incl. post-413 429 rotations (+ test R4); (4) N1 asserts the 2MiB
tier-0 hard cap; (5) N3's cache-size alternative removed (encoder-seam counter only).
Also adopted reviewer note: cache entries are immutable snapshots.
