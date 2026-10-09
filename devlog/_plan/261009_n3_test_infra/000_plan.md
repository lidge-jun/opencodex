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

