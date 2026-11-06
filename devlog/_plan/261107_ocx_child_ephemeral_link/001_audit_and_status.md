# `261107_ocx_child_ephemeral_link` — Audit Disclosures & Phase Status Ledger

> Reader contract: Maintainer and reviewer ledger tracking PABCD audit rounds, model-inheritance disclosures (`REVIEW-DECORRELATE-01`), and per-phase verification evidence (`LOOP-PESSIMIST-01`).

## 1. Model Inheritance Disclosure (`REVIEW-DECORRELATE-01`)

Per explicit user directive (`"너 상속 으로 해서"`), all PABCD subagents (`explorer`, `architect`, `reviewer`) inherit the coordinator's model (`google-antigravity/gemini-4-argon`) without mutating shared `.codexclaw` subagent configuration files. Cross-family decorrelation was therefore intentionally waived by user instruction and compensated by fresh zero-conclusion prompts and real command-backed verification.

## 2. `wp0` (Docs-Only Roadmap Cycle) Audit & Closure

- **Architect consultation**: Handle `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7` returned `ALIGNED` on `ARCH-01..ARCH-07`; `Gap-1` (`models_cache.json` snapshot/restore in `ChildJournalV1`) and `Gap-2` (Windows owner-only DACL via `Win32_Security_Authorization`) folded into `020_wp2_rust_ocx_child.md`.
- **Independent A-gate review**: Handle `01a1b197-8e50-7722-bf0d-d13bb303f767` Round 1 returned `VERDICT: GO-WITH-FIXES (blockers=2)`; all 5 findings (omitting `restartCapability` on `ocx-child` client `/healthz`, `ephemeralChild`-specific `apply()` failure recovery string + fail-closed detached `restart`, `010` header dependencies + exact `isAllowedRequestOrigin` loopback Host/Origin check, `sync --json` stderr redirection + attached `serve` start rationale, and clean `corrupt_managed_span_refused` vector) were folded into `010`, `020`, and `030`. Round 2 re-audit returned `VERDICT: PASS` (`blocking_issues: []`).
- **`LOOP-PESSIMIST-01` notes (`wp0`)**:
  - *Dead hypothesis*: Upstream socket pooling across relayed requests (`ARCH-02` alternative) died against `src/server/index/link-relay-sessions.ts:105` (`consume(nonce)` is strictly single-use), confirming one-shot `SingleSocketUpstream` per relayed request.
  - *Dead hypothesis*: Advertising `restartCapability: "v1"` on `ocx-child` `GET /healthz` died in Round-1 audit because `ocx-child` does not serve `POST /api/system/restart` and `isChildHealth(..., "client", port)` does not require it.
  - *Refutation trigger for `wp1..wp3`*: Any divergence between TypeScript and Rust outputs on `tests/fixtures/link/ocx-child-conformance.json`, or Windows encoded PowerShell exceeding `8000` chars.

## 3. Work-Phase Status Table

| Work Phase | Status | Summary |
|---|---|---|
| `wp0` | Completed | Docs-first roadmap (`000_roadmap.md`, `001_audit_and_status.md`, `010..040` decade PRDs) audited and locked with zero production edits |
| `wp1` | Pending | Shared golden conformance fixture (`ocx-child-conformance.json`), `src/link/ephemeral-child.ts`, and `ocx-child-conformance.test.ts` |
| `wp2` | Pending | Standalone Rust crate `native/ocx-child` (HTTP/1.1+SSE relay, HMAC v2, OCX-6 parity, `#1798` offline journal) |
| `wp3` | Pending | Home discovery, detached enrollment preflight, `package.json` scripts, and compiled-binary E2E lifecycle tests |
| `wp4` | Pending | `structure/` + `docs-site/` sync, full gate matrix, branch push, and unmerged PR targeting `dev` |
