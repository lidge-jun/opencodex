# 010 — stale pull requests: 18 audited

"Behind" is GitHub compare's count of `dev` commits absent from the PR head, measured
2026-08-26 against `0a0a8821b`. Ages are completed days.

| PR | Author | Age | Draft | CI | Behind | Scope | Verdict |
|---|---|---:|:---:|---|---:|---|---|
| #1557 | LeoWang331 | 13d | yes | 5 pass / 3 fail | 1855 | 2545+/69−, 28 files; catalog endpoint, server auth | NEEDS-AUTHOR |
| #1645 | waw4303 | 12d | yes | 13 pass | 419 | 1425+/151−, 68 files; vision runtime, GUI | NEEDS-AUTHOR |
| #1756 | takltc | 10d | no | 14 pass | 380 | 850+/116−, 17 files; Grok injection | NEEDS-AUTHOR |
| #1769 | dbc-hbin | 10d | yes | 9 pass / 2 fail | 411 | 963+/36−, 19 files; OAuth + GUI | **SUPERSEDED — closed** |
| #1794 | riique | 10d | no | 10 pass | 71 | 1916+/7−, 50 files; recovery + OpenRouter GUI | REVIVABLE-LARGE |
| #1829 | luvs01 | 9d | no | 10 pass | **0** | 2878+/2−, 4 files; reset-credit ledger | REVIVABLE-LARGE |
| #2033 | louis-tepe | 7d | yes | 8 pass | 869 | **14+/0−**, 2 files; sidecar enabled field | **REVIVABLE-SMALL** |
| #2050 | x3M3x | 7d | no | 14 pass | 44 | 404+/18−, 15 files; combo strategies | REVIVABLE-LARGE |
| #2083 | zhou-zhichao | 7d | no | 19 pass / 6 cancelled | 239 | 1003+/65−, 24 files; xAI image relay | NEEDS-AUTHOR |
| #2113 | cb8010d6 | 6d | no | 8 pass | 71 | 2228+/110−, 65 files; encrypted V2 trust | NEEDS-AUTHOR |
| #2122 | chilung-cgu | 6d | yes | 5 pass | 54 | 730+/29−, 15 files; catalog retention | REVIVABLE-LARGE |
| #2123 | chilung-cgu | 6d | yes | 3 pass / 1 fail | 54 | 755+/40−, 9 files; Antigravity quota | NEEDS-AUTHOR |
| #2213 | louis-tepe | 5d | yes | 11 pass | 535 | 494+/101−, 18 files; Grok tool projection | NEEDS-AUTHOR |
| #2215 | parkjs101 | 5d | yes | 9 pass | 537 | 126+/41−, 8 docs | **SUPERSEDED — closed** |
| #2230 | ppvia | 5d | yes | 10 pass / 6 fail | 535 | 1637+/61−, 33 files; Gemini OAuth | NEEDS-AUTHOR |
| #2244 | ZSN12 | 5d | yes | 6 pass / 4 fail | 511 | 913+/0−, 9 files; WorkBuddy OAuth | NEEDS-AUTHOR |
| #2299 | abhisheksharma2411 | 4d | no | 9 pass / 3 cancelled | 11 | 910+/3−, 10 files; display labels | REVIVABLE-LARGE |
| #2326 | JasonSujaya | 4d | yes | 4 pass / 1 fail | 363 | 398+/7−, 14 files; GUI shortcuts | NEEDS-AUTHOR |

## Findings that are not obvious from the table

**#1829 is 0 commits behind `dev` with CI green.** The only stalled PR that is not stale. If
any large PR is worth a maintainer pass, it is this one — the usual rebase tax is zero.

**#2033 is 14 lines and a real gap.** Both GET and PUT sidecar responses return model, backend,
stream and X-search fields but no `enabled` field
([config-routes.ts:571](../../../src/server/management/config-routes.ts) and :809). Worth a
maintainer revival. Caveat: 869 commits behind, so it is a fresh reimplementation rather than a
rebase.

**#2083 does not merely conflict — it disagrees.** The xAI image bridge landed via
`de35caa4d`, but current code returns no image credential for OAuth configurations
([images/plan.ts:32](../../../src/images/plan.ts)) and the public guide states an API key is
required. The PR proposes the opposite contract. That is an owner decision about the image-auth
boundary, not a rebase, and asking the author to "just rebase" would waste their time.

**#1794 is a partial duplicate, not superseded.** Core recovery landed via `9bea7707b` and
configurable OpenRouter routing via `3c6f3caa4`, but the PR's GUI exposure files have no
equivalent on `dev`. Closing it as superseded would overstate the equivalence.

**#2123 is NOT superseded** by existing Antigravity quota work: per-account eligibility still
accepts Anthropic only ([providers/quota.ts:1447](../../../src/providers/quota.ts)).

**No PR is abandoned.** All 16 distinct author accounts still resolve on GitHub. Conflict volume
alone was not treated as abandonment — that would be closing other people's work for the
convenience of the backlog.

