# B5 — narrowed carries, a Command Code retry default, and evidence-backed closes

Base: `dev` `4b3737fc5c` (after B4 #6063). Branch `codex/train3-b5`.

Previous D (B4): #6043 landed; #6044 held on its security blocker, #6051 on the owner's `.agents/` decision. The
coordinator asked the lane to continue until nothing in scope is landable.

| Item | Plan |
|---|---|
| #5953 (codingbooo) → #5465 | Carry, then narrow `protectGlmSummaryBudget` as the maintainer round asked: Z.AI host only (from the provider base URL), caller effort `high`/`max` only, the checkpoint shape (summary instruction plus a `<conversation>` transcript of at least 2000 characters), and each tiny cap field (≤1024) raised on its own to 8192. Negative tests for each boundary. |
| #5180 (issue, found through Aside) | With no `retryOn429` knob, a key-auth Command Code destination gets the patient same-key policy OpenCode Go already has, so a burst 429 on a long turn waits (honoring Retry-After) instead of failing to the client. An explicit `retryOn429`, including `enabled: false`, still wins; OAuth is never replayed. |
| #6027 (codingbooo) → #5569 | Carry, then fix the owner's three blockers: replace only when the whole body carries exactly one `<skills_instructions>` block (otherwise pass through); store a new snapshot only after `prepareResponsesRequest` reaches its success return, so a rejected first request pins nothing; share a snapshot without a principal only for loopback admission. Tests for each. |
| #4055 | Close as fixed for the reported Tailscale Serve case (12-hour identity sessions with sliding renewal, #2776), and correct the stale `management-api.md` sentence that says remote binds never get a session. |
| #3433 | Close with evidence: per-conversation identifiers are preserved at the forward boundary (#4365) and the managed Hermes export now sends one (#5742); 26 pinned tests pass. |

Held: #6030 (draft; launchd PATH adoption drops non-PATH changes, two ratchet breaches, WinSW gap, conflict),
#4143 (needs the reporter's desktop routing details).

## Audit (Kimi, NEAR-PASS) and folded decisions

- #5180: the predicate is key auth plus the existing `isCanonicalCommandCodeBaseUrl`; a row repointed at a custom
  relay keeps fail-fast unless `retryOn429` is set.
- #6027: `snapshotSkillsCatalogInBody` splits into a replace-only lookup before parsing and a store call at the
  success return. Residuals named in the PR: a snapshot can be pinned by a turn whose upstream request later fails;
  on a no-auth server bound beyond loopback, snapshots are keyed by conversation id alone, matching that server's
  trust model.
- #5953: the gate reads effective effort after combo overrides; transcript shapes that #5465 does not show stay
  unprotected, which is today's behavior.

## Build and evidence

| Commit | What |
|---|---|
| `4fda15d338` | #5180: canonical key-auth Command Code gets the patient same-key 429 policy; test fails without the fix |
| `3876151d01` | #5953 carried |
| `fb3faab205` | #5953 narrowed: Z.AI host, effective `high`/`max`, checkpoint transcript ≥ 2000 characters, per-field cap raise to 8192; negative tests per boundary |
| `25e01a8e2b` | #6027 carried (layout registries unioned, entry kept on an existing line) |
| `01b7e24d2d` | #6027 blockers: one-block rule, store at the success return, anonymous sharing only on a no-auth server; three tests that fail on the PR head |
| `ad3b374820`, `2256d097e6` | `management-api.md` describes remote dashboard sessions as shipped (#4055) |

Closed during this cycle with evidence: #3433 (identifiers preserved at the forward boundary, #4365; managed Hermes
sends one, #5742; 26 pinned tests pass).

Aside: #5953 shows two CHANGES_REQUESTED reviews (the overbreadth this batch narrows); #6027 shows the owner's
three-blocker review this batch answers; #5465, #5569 and #5180 pages captured. One Aside capture failed once with a
daemon `Aside.controlTab` error after an Aside update and succeeded on retry.

Local proof at `2256d097e6`: typecheck, structure and privacy exit 0; six focused files 60 pass; `tests/adapters/openai`
591 pass; eight request-preparation files 108 pass. The full `tests/responses` directory shows 13 failures in
`responses-compaction-recovery.test.ts` that do not reproduce when that file runs alone (33 pass on this branch and on
`dev`); the same directory run on `dev` is recorded below.

The full `tests/responses` run on `dev` `4b3737fc5c` shows the same 13 `responses-compaction-recovery` failures
(3567 pass, 13 fail), so they are cross-file interference in a directory run, not this batch; the branch run was 3576
pass, 13 fail.
