# 070 — A-phase audit synthesis, round 1 (REVIEW-SYNTHESIS-01)

Reviewer: `gpt-5.6-sol` explorer subagent (nickname Lorentz), read-only plan audit.
Verdict received: **FAIL**, `blocking_issues: 4`.
Reviewed: `050_issue710_kiro_windows_cli_db_path.md`, `060_issue712_codex_account_400_already_fixed.md`.

Every blocker was independently re-verified by the main agent against the tree before disposition.
No blocker was rebutted; all four are accepted. Root causes below.

## Blocker 1 (High) — one-platform resolver breaks existing Kiro fixtures. ACCEPTED

Main-agent verification: `tests/kiro-oauth.test.ts:76` seeds
`join(tmp, "Library", "Application Support", "kiro-cli")` — the **macOS** layout — and
`tests/kiro-review-regressions.test.ts:44` `kiroCliDbPath()` hardcodes the same macOS layout. Both
suites set `process.env.HOME = tmp` (`tests/kiro-oauth.test.ts:35`) and rely on
`nativeKiroCliSessionEntries()` returning the macOS candidate **on every platform**. Narrowing the
resolver to the host platform makes those fixtures invisible on the Linux and Windows CI legs.

Root cause of the plan defect: the plan reasoned about production callers (correctly — all three
use `existsSync` guards, so a narrowed list is safe at runtime) and never asked what the **test
harness** depends on. The current cross-platform return value is load-bearing for fixtures, not for
production.

Root cause is NOT the production design. Reviewer independently reached the same conclusion:
narrowing "improves the latter two by targeting the database the local CLI actually mutates". Keep
per-platform production behavior; fix the harness.

Amendment: see 050 revision — fixtures become platform-aware and `LOCALAPPDATA` is isolated in
`beforeEach`/`afterEach` so a Windows runner cannot read the real user profile.

## Blocker 2 (High) — WP2 conflated two separately shipped fixes. ACCEPTED, and it already shipped

Main-agent verification:

```
$ git log --format='%h %ad %s' --date=short -1 903b62c7d
903b62c7d 2026-07-28 fix(codex): same-request multi-account failover on quota 429 (#584) (#585)

$ git tag --list 'v*' --contains 903b62c7d --sort=v:refname | head -3
v2.7.43
```

So the version boundaries are **two, not one**:

| Symptom | Commit | First release |
|---|---|---|
| Allow-listed model-400 retry | `b5ca7f53a` (2026-07-24) | **v2.7.37** |
| Pre-stream 429/402 quota failover | `903b62c7d` (2026-07-28) | **v2.7.43** |

The code comment at `src/server/responses/core.ts:307-310` states the mechanism plainly:
"One bounded alternate-account retry ... Used for allow-listed model-400 and for pre-stream 429/402
quota failures (#584)." It is **one** bounded retry — `retryCodexPoolOnAlternateAccount` resolves a
single alternate with `excludeAccountId: firstAuthCtx.accountId` (`core.ts:320-325`). With ~10 pool
accounts, two consecutive exhausted accounts do not walk to a third within the same request.

Root cause of the plan defect: I read the two `poolRetryOutcome` branches sharing one call site and
inferred a shared ship date. Sharing a call site says nothing about when each branch landed. The
quota branch is 4 days younger and 6 releases later.

**External-state consequence (the expensive part).** The reviewer flagged that #712 was already
closed. Verified: closed `2026-07-29T22:38:50Z` with a comment by `lidge-jun` that asserts

> "That same retry path is what drives the account switching you found missing ... quota rejections
> and this model rejection both route through it."

directly under a **v2.7.37** upgrade instruction. That is inaccurate for the second symptom: a user
upgrading to exactly 2.7.37–2.7.42 gets the 400 fix and **no** same-request quota failover. The
comment does say "Current release is 2.7.43. Please upgrade", so the recommended action lands the
user in a correct place — but the stated reasoning is wrong and would mislead anyone pinning 2.7.37.

Disposition: WP2's remaining work is a **public correction comment on #712**, not a fresh close.
060 is rewritten as a retrospective. Also record the honest limitation: one bounded alternate, and
mid-stream quota stays terminal by design (`core.ts:1477`).

## Blocker 3 (Medium) — Windows fallback derives from the wrong home. ACCEPTED

Main-agent verification: `src/oauth/kiro-credentials.ts:68` is
`return process.env.HOME || homedir();` — `HOME` wins. On Windows, Git Bash / MSYS / CI shells
commonly export a POSIX-style `HOME`, so a `LOCALAPPDATA`-absent fallback built on `userHome()`
would probe a non-native path. The cited precedent does the opposite: `desktop-3p-paths.ts:81-84`
passes `home: homedir()` into the pure resolver, deliberately not an env-overridable home.

Root cause: I reused the file's existing `userHome()` helper for consistency without checking that
its `HOME`-first semantics are wrong for a Windows-native path.

Amendment: the Windows branch prefers `LOCALAPPDATA`, then `USERPROFILE`, then the injected
`home`; the wrapper injects `homedir()` for the platform-native default rather than `userHome()`.
POSIX branches keep `userHome()` semantics so existing `HOME`-based fixtures still work.

## Blocker 4 (Medium) — missing user-facing sync and the mandated OAuth gate. ACCEPTED

Main-agent verification: `src/oauth/kiro.ts:286-293` builds the snapshot-failure repair message
naming only `~/.local/share/kiro-cli/data.sqlite3` and
`~/Library/Application Support/kiro-cli/data.sqlite3`. After this change a Windows user can hit that
exact error and be told to repair two paths that do not exist on their machine.
`src/AGENTS.md` requires the full `bun run test` for OAuth-surface changes; the plan ran only
targeted suites.

Root cause: I scoped by "where is the bug" instead of "what does this change make reachable". Adding
a Windows discovery path makes Windows-reachable error copy a first-class part of the change.

Amendment: include the repair-message path list, run `bun run test` plus typecheck and privacy scan.
Installer copy and translated provider guides are deliberately deferred (see 050 revision) — that is
a pre-existing docs gap, not created by this change, and is recorded as follow-up rather than
silently dropped.

## Cross-blocker conflicts

None. Blockers 1 and 3 both touch the resolver but in non-conflicting ways: 1 changes the test
harness, 3 changes how the Windows branch derives its base directory. Blockers 2 and 4 are
independent surfaces (GitHub state vs CLI copy).

## Round-1 disposition summary

| # | Severity | Disposition | Where amended |
|---|---|---|---|
| 1 | High | Accepted | 050 §File change map (test harness), §Accept criteria |
| 2 | High | Accepted | 060 rewritten as retrospective correction |
| 3 | Medium | Accepted | 050 §File change map (Windows base resolution) |
| 4 | Medium | Accepted | 050 §Scope boundary + §Verification commands |

Non-blocking reviewer findings adopted: criterion 5 exercises public behavior instead of exporting
private `sqliteEntries()`; the "pure resolver is required" claim is softened to "preferred" since
`process.platform` is stubbable in this repo (`tests/server-auth.test.ts:1838-1841`) — the pure
resolver is still the better design for host-independent win32 coverage.

---

# Round 2 (same reviewer, DISPATCH-ACTOR-01)

Verdict: **GO-WITH-FIXES (blockers=2)** — both Medium, both accepted and folded before B.
Main-agent judgment: **near-pass**. No High/Critical remained.

## Blocker 2.1 (Medium) — two conflicting resolver implementations in 050. ACCEPTED

The r2 edit appended the corrected `LOCALAPPDATA -> USERPROFILE -> home` chain as a separate snippet
while the r1 `LOCALAPPDATA || home` version stayed in the main code block. A builder reading the
first complete function would silently reimplement blocker 3, and the stale JSDoc still claimed
off-host testing was impossible.

Root cause: I patched by appending a correction instead of rewriting the authoritative block. In a
diff-level plan the code block IS the executable artifact — two versions means the document has no
single truth.

Fix: merged into one authoritative block carrying the corrected chain, JSDoc rewritten (stubbable
`process.platform` vs non-following `os.platform()`), the duplicate snippet deleted, and an explicit
"do not implement any earlier draft" instruction added. Criterion 5 now states the public-behavior
assertion inline rather than as a trailing note.

## Blocker 2.2 (Medium) — the new `USERPROFILE` rung had no activation criterion. ACCEPTED

Three Windows bases existed but only two were covered, violating this plan's own
C-ACTIVATION-GROUNDING-01 requirement. A middle rung with no test can regress invisibly.

Root cause: I added a resolution rung and did not extend the criteria table in the same edit.

Fix: criterion 10 drives `LOCALAPPDATA: "   "` + `USERPROFILE: "C:\Users\u"` and asserts
`C:\Users\u\AppData\Local\Kiro-Cli\data.sqlite3`. All three rungs now have activation proof.

## Main-agent finding the audit missed (recorded for honesty)

Round 1 named three fixture suites. A full sweep found **nine** hardcoded macOS fixture sites across
**four** files — `tests/oauth-refresh.test.ts:53` was absent from the audit. Round 2 confirmed the
corrected four-file scope is complete. The reviewer's blast-radius instinct was right; its enumeration
was short. Independent verification is not optional even for an accepted blocker.

## Reviewer verifications adopted without change

- Env isolation of `LOCALAPPDATA` + `USERPROFILE` is sufficient — no `APPDATA`/`HOMEDRIVE`/`HOMEPATH`
  rung exists in the resolver.
- Fixture semantics preserved: the helper picks the same path production picks per host, so no
  existing assertion weakens.
- Docs deferral acceptable: `providers.md:160-164` already claims platform Kiro CLI store discovery,
  so this change makes an existing statement true on Windows rather than contradicting it. D must
  create the concrete installer-copy follow-up.
- `tests/oauth-refresh.test.ts` added to the focused command line.
- 060 accuracy confirmed against live state: #712 still closed carrying only the inaccurate original
  comment, so the correction is genuinely still pending.

## A-gate exit decision

AUDIT-LOOP-01 permits A>B on main-judged near-pass when every High/Critical blocker is folded or
rebutted with rationale and only non-blocking residuals remain. Round 1's four blockers (2 High,
2 Medium) are folded; round 2's two Medium blockers are folded. Residual carried into B: the
installer-copy / translated-guide docs debt, deliberately deferred with a D follow-up obligation.
