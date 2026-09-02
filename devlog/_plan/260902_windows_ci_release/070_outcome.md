# 070 — Outcome: v2.40.0 released, Windows shards repaired

## Windows CI (wp2/wp3)

Landed on dev as #3257 (`19b0157bb`) and #3258 (`a6ee24f5b`). Root cause was the product:
`e5d588669` turned the config-dir ACL harden into a fire-and-forget `icacls.exe` child that
`server.stop()` never waited for; mandatory locking made every fixture teardown EPERM/EBUSY.

Dispatch history on immutable refs of the stack tip (windows-latest, all four shards were red on
every branch since 2026-08-30):

| run | head | 1/4 | 2/4 | 3/4 | 4/4 |
|---|---|---|---|---|---|
| 33595585136 | e1acb7f7a | 8 fails | 2 | 1 | cancelled |
| 33597649234 | 079bec4e0 | ✓ | ✓ | ✓ | 25-min ceiling (native-main-refresh microtask spin) |
| 33601508392 | 2bf189d9f | ✓ | ✓ | ✓ | ceiling (two more spins) |
| 33603770447 | 5ffba3b0a | ✓ | fail (write-lock hold) | ✓ | 2 (oauth-manual-code) |
| 33605723635 | 477c64e50 | ✓ | ✓ | ✓ | 2 (oauth-manual-code, fixed next) |
| 33605898170 | 2e2b411ba | 1 (retained-root wait) | ✓ | ✓ | 2 (reauth-bind EPERM, native-main EBUSY) |
| 33610501053 | 26de9cac0 (codemod) | ✓ | ✓ | ✓ | 2 (reauth-bind, startup port wait) |
| 33612731522 | f85978251 | ✓ | in flight at merge | 4 (oauth-public-surface, fixed) | in flight |

Every shard that finished ran the full file set; each residual was a distinct bare-`rmSync`
or child-boot-timing site and was fixed at that site (or, for teardown, by the 870-site codemod).
The user chose to merge and release on this evidence rather than wait for one more 25-minute
round; the fixes for the last two residuals are on dev.

Reviewers (read-only, sol/high): Lovelace FAIL→fixed (finally), Hooke FAIL→fixed (win32
admission coverage), Euler FAIL→fixed (listener-close oracle, marker deadlines). Codemod builder
Gauss: 381 files / 870 sites, test:changed 14165 pass.

fuck-powershell: 56e1801, 2f2107d — 87→90 cases, graph 313/643, validate OK.

## Regression audit (wp4)

Reused `devlog/_plan/260902_bug_label_drawdown/071_regaudit_landing.md` (four reviewers,
no regression main..dev at 5bc6939d8) plus the Windows repair reviews above for the delta since.

## Release (wp5)

- Promotions: #3260 → preview `7fd141f2a`, #3261 → main `ac7864785`.
- First dispatches (33615174183 / 33615177849) died at `startup_failure`: `release.yml`'s
  reusable call to `dev-version-bump.yml` (#3129) had never run live and the caller job lacked
  the callee's `contents`/`pull-requests` write. Fixed as #3262 (`7ce0ba518`), carried onto
  main (#3263 → `35ff3a462`) and preview (#3264 → `49812c9e8`).
- Service-lifecycle's push trigger is path-filtered and the workflow-only cherry-pick touched
  none of its paths, so the release gate found no run for the new tips; dispatched by hand on
  both refs (33617431510, 33617434280), green.
- Release runs 33617562805 (preview) and 33617573070 (main): publish SUCCESS.
- Proof: npm `latest=2.40.0` gitHead `35ff3a462…`, `preview=2.40.0-preview.20260902` gitHead
  `49812c9e8…`; GitHub releases v2.40.0 / v2.40.0-preview.20260902; tags equal branch tips.
- Dev bump: the bot job pushed `codex/dev-version-2.41.0` but `gh pr create` was refused
  ("GitHub Actions is not permitted to create or approve pull requests" — repository Actions
  setting). Opened by hand as #3265 → `272ff6b11`; dev now carries 2.41.0.

## Follow-ups (not blocking)

1. Repo setting: allow Actions to create PRs, or the bump will need a hand each release.
2. A release-branch commit that touches only `.github/workflows/release.yml` needs a manual
   `service-lifecycle.yml` dispatch before the release gate passes (path filter).
3. One more Windows dispatch on dev after #3258 to confirm 4/4 with the last two residual fixes
   (dispatched below). Result: 33618250161 on 272ff6b11 — windows 1/4, 2/4, 3/4, 4/4 SUCCESS; every other job SUCCESS.
