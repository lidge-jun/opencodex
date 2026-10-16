# N3 test infrastructure: client-home isolation and fixture determinism

Unit for three test-infrastructure defects reported against dev in October 2026.
Each item ships as its own pull request to `dev` so a reviewer can judge the
home-isolation change apart from the two fixture fixes.

| Doc | Issue | Change | PR branch |
| --- | --- | --- | --- |
| 010 | #6775 | Pin client homes in the test sandbox, resolve the Claude default home at call time, and make the test guard refuse writes to the real Claude config directory | `codex/n3-test-infra` |
| 020 | #6777 | Stop the combo management fixture from reaching provider discovery and keep a timed-out case from running into the next fixture | `codex/n3-combo-rename-fixture` |
| 030 | #6776 | Give the native Codex toggle fixture deterministic service-manager evidence | `codex/n3-codex-toggle-fixture` |

## Constraints

- Production behavior stays the same. The only production edits are in 010:
  `claudeConfigDir()` reads the home the way Node's `os.homedir()` does at call
  time, and two Claude writers call a guard that is inert unless
  `OCX_TEST_HOME_GUARD=1`.
- Other `homedir()` call sites (OpenCodex config dir, Codex home, client
  integrations) are deliberately out of scope. Moving them to an environment-first
  home would change where production reads its own config on Windows hosts whose
  `HOME` differs from the profile directory. The sandbox and the guard cover tests
  without that risk.
- Workflows under `.github/` are not touched (L7 #6806 owns CI changes).
- Every local test run starts Bun with a temporary `HOME`, `USERPROFILE` and
  `CLAUDE_CONFIG_DIR`; a bare `bun test` against the developer home is not used,
  because that is the defect in #6775.
- File-size ratchet: no capped file grows past its cap. New tests are registered in
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

## Order

010, 020 and 030 are independent; each starts from `origin/dev`. 010 goes first
because the other two reproductions are only safe once the sandbox pins the Claude
home.

## Verification

Focused files per doc plus `bun run typecheck`, run with a temporary home at
process start. The full suite runs in hosted CI on each PR's exact head.


## Outcome

**DONE**, 2026-10-09. All three items merged into `dev` with squash admin merges, after
exact-head CI concluded `success` and independent gpt-6.1-sol reviews passed:

| Doc | Issue | PR | Merge commit | Exact-head CI |
| --- | --- | --- | --- | --- |
| 010 | #6775 | #6835 | `7f642e30e8` | all executed jobs passed at `9ac1a95263`, including the nine Windows shards, `npm-global windows-latest` and `keyring windows` |
| 020 | #6777 | #6833 | `6d7e5f48ad` | all executed jobs passed at `0fa7ee87df`; Windows shards and other conditional jobs skipped (not selected for this diff) |
| 030 | #6776 | #6834 | `c4baa30e09` | all executed jobs passed at `c6addbb97e`; Windows shards and other conditional jobs skipped (not selected for this diff) |

Before merging, the three heads were combined on `dev` `b89bbfb083` (#6835 shares
`layout.json` and `test-layout-expected.json` with changes that landed meanwhile): 180
focused tests, typecheck and `structure:check` passed. The three issues were closed with
a comment naming the PR and merge commit.

010 went through four review rounds. The plan's two guarded writers grew to four (agent
sync, gateway cache, served-catalog invalidation, intercept `settings.json`), and the guard
now judges every touched path by where it resolves (directory and file links), resolves its
roots at check time, compares case-insensitively on macOS and Windows, splits containment
on the platform separator, and covers removals with the same comparison while keeping the
checkout-content lift.

Not done here: other client homes that still default to `os.homedir()` (Claude Desktop
config library, several client-integration writers, Kiro, XDG-based clients) remain
follow-up candidates. Native Windows was exercised only through hosted CI.

