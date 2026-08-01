# 021 — WP3 audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Reviewer: sol agent "Gauss" (WP3 A-gate round 1). Verdict: **FAIL** — 5 High +
2 Medium. All seven ACCEPTED; 020 rewritten with the folds.

## Dispositions

1. [High] `auto-switch` grammar missing `<provider>` + `status` — ACCEPT. Grammar is
   now `auto-switch <provider> <on|off|status|threshold N>`; provider required,
   openai-only guard via classifyAccount; status reads GET active's
   autoSwitchThreshold. Matches the issue's own proposal.
2. [High] refresh can't print quotas through the current DTO layer — ACCEPT.
   account-api gains a quota-carrying codex reader (`CodexQuotaDto` projection:
   weekly/monthly % + reset-at); `refresh openai` prints per-account quota lines,
   `--json` includes the quota object.
3. [High] apiJson GET/PUT-only + account-api.ts missing from write scope — ACCEPT.
   Method union extended to POST/DELETE in account-api.ts; write scope includes
   src/cli/account-api.ts.
4. [High] active-removal semantics wrongly normalized — ACCEPT. Family-specific
   post-delete output: codex → pin cleared, prints `auto (no pin…)`; oauth →
   promoted first-remaining id or "no accounts remaining"; keys → promoted id or
   "no keys remaining". Post-delete verification failure is surfaced distinctly
   from the delete failure.
5. [High] stdin design leaks/echoes — ACCEPT, redesigned: add-key reads stdin
   ONLY when it is not a TTY (pipe/redirect from a secret manager); TTY → exit 1
   with pipe guidance (no literal `echo <key> |` example — a variable/secret-
   manager example instead). The key is never echoed; if the returned label
   equals the submitted key it is suppressed. Stdin reader + timeout (15s) are
   injected via AccountDeps for deterministic tests.
6. [Medium] test matrix collision/staleness — ACCEPT. WP3 rows renumber from 18
   (WP2 shipped 1-17); new rows cover oauth re-GET refresh, keys refresh
   rejection, auto-switch status/on/off/threshold/wrong-provider, family-specific
   promotion, last-credential removal, DELETE/POST failures, TTY rejection,
   label-equals-key suppression, help text.
7. [Medium] module budget hand-waving — ACCEPT. NEW `src/cli/account-extended.ts`
   owns the four extended handlers + stdin helpers; account.ts stays the router
   (≤ ~330 lines); account-extended.ts ≤ ~260 lines.

Re-audit round 2 with the SAME reviewer on the rewritten 020.

## Round 2 verdict: FAIL (4 findings) — dispositions

1. [High] module split dependency cycle — ACCEPT. `classifyAccount` + `AccountDeps`
   move to `account-api.ts`; `account.ts` re-exports `classifyAccount` (test
   import surface unchanged). One-way direction: account.ts → account-extended.ts
   → account-api.ts. `readStdinLine` single owner = account-extended.ts;
   account-api.ts only carries the injection types.
2. [High] label containment leak — ACCEPT. Equality suppression replaced with
   redaction: every exact occurrence of the trimmed key becomes `[redacted]` in
   human and `--json` output; containment test added (row 33).
3. [Medium] row-numbering collision — REBUT premise, keep outcome. The "rows
   18-21 already present" observation was Halley's in-flight WP3 work being
   written at review time, not stale WP2 leftovers. Integration gate verifies the
   final suite numbering matches 020 (rows 18-33).
4. [Medium] missing failure-branch rows — ACCEPT. Rows 30-33 added: delete
   failure after pre-check / post-delete re-read failure (nonzero + "delete may
   have succeeded"), add-key POST non-201 / stdin timeout cleanup, refresh +
   auto-switch API failures, label containment + help family assertions. Accept
   total updated to 33.

Round 3 goes to the SAME reviewer on the re-amended 020; the B worker received
the R2 deltas mid-flight to fold directly.

## Round 3 verdict: GO-WITH-FIXES (3 Medium) — near-pass, residuals folded

1. [Medium] `AccountDeps` type must also be re-exported — folded: 020 module
   direction now requires re-exporting the moved public types, and the stale
   "stdin helper" scope line was corrected to "stdin injection types".
2. [Medium] remaining unactivated branches — folded: rows 34-36 added (promotion
   variants incl. non-pinned codex + oauth last-account, add-key wrong family,
   refresh/remove --json envelopes); row 33 strengthened to assert `[redacted]`
   in BOTH human and --json output. Accept total now 36.
3. [Medium] --json contracts undefined for refresh/remove — folded: envelopes
   specified (refresh → `{accounts}` with quota; remove → `{ok,provider,id,
   removedActive,promotedActiveId}` / failure `{error}` on stderr).
4. [Info] No cycle, no contract mismatch, no new High/Critical — module
   direction confirmed sound.

Main-agent judgment: near-pass — every High/Critical across 3 rounds resolved
or rebutted with GUI-parity evidence; residuals folded into 020 same-day and
sent to the B worker mid-flight.

## WP4 (docs) audit round — GO-WITH-FIXES (5 Medium), all folded

Gauss reviewed the docs diff against the shipped CLI surface. Dispositions:

1. [Medium] refresh docs claimed all API failures exit 1 — folded: all locales now
   distinguish management-API failures (exit 1) from upstream quota-probe failures
   (degraded null/stale, exit 0). (Also confirmed the 020 B-phase deviation to the
   real quota-report endpoint was already recorded in 020.)
2. [Medium] "metadata exactly as the API returns" exceeded implementation — folded:
   all locales document the client-side display conveniences (main alias, Account N
   ordinal, plan/label fallback chain) while keeping the no-raw-credentials
   guarantee.
3. [Medium] kiro note documented as unconditional — folded: all locales qualify it
   appears when a stored kiro account exists.
4. [Medium] README "deep-link only" judgment was FALSE — folded: `ocx account` rows
   added to the CLI lists in README.md:282, README.ko.md:249, README.zh-CN.md:242;
   999_closeout corrected.
5. [Medium] kiro guidance row still marked gap — folded: 004 row flipped to full
   (note line when a stored kiro account exists; mock row 12).

No High/Critical. Near-pass exit; B = the folds above + docs commit.
