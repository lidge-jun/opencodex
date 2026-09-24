# 010 — carry #5713, #5703, #5548 slice

## #5713 (fixes #5699) — author 정우철 <oocheol@naver.com>
Files: src/client/connect.ts, src/client/state.ts (pending-connect fingerprint marker client-connect-pending), src/service/cli.ts (removeServiceTokenAfterUninstall under client lifecycle + config mutation locks: removed|absent|retained|unverified), structure/clients/claude-desktop.md, structure/runtime.md, docs-site guides/remote-hub.md (en+ko), tests/clients/client-connect.test.ts, tests/service/service-secrets.test.ts.
Method: git diff merge-base..carry-5713 | git apply -3. Check other docs-site locales of remote-hub.md for consistency (PR touched en and ko only).
Tests: bun test tests/service/service-secrets.test.ts tests/clients/client-connect.test.ts.
Security: credential deletion boundary — uninstall deletes the service token only when client state is disconnected and no pending marker owns the fingerprint.

## #5703 (fixes #5701) — Konstantinos <37538071+konstantinosbotonakis@users.noreply.github.com>
Files: src/codex/native-residue.ts, structure/config.md, tests/codex-integration/codex-native-residue.test.ts. Check file-size caps for the test file.

## #5548 slice — Vadevious <Vadevious@users.noreply.github.com>
Only src/codex/home.ts (import expandUserPath from ../config/paths), structure/codex-home.md line, tests/codex-integration/codex-home-wsl.test.ts (new: register in layout.json explicit + test-layout-expected.json if not matched by a seed). Excluded: tests/cli/cli-help.test.ts, tests/service/service-probe-docker.test.ts, tests/service/service.test.ts.
Audit fold: codex-home-wsl.test.ts already exists on dev (from #5720) and is registered; carry only the PR's added fresh-process case into it. home.ts:4 currently imports from ../config (barrel) — the fix switches to ../config/paths.

## wp1 P (executable)
- All three squash diffs pass git apply --check -3 on 34fb6d649c (/tmp/l4-5713.diff, /tmp/l4-5703.diff, /tmp/l4-5548.diff limited to 3 files).
- Commit order: #5713, #5703, #5548 slice; each commit carries Co-authored-by for the PR author.
- #5713 docs: en/ko remote-hub.md updated by the PR; DeepSeek writer adds the same paragraph to fr, ja, ru, tr, zh-cn, zh-tw remote-hub.md next to the service-api-token paragraph.
- Focused tests: tests/service/service-secrets.test.ts tests/clients/client-connect.test.ts tests/codex-integration/codex-native-residue.test.ts tests/codex-integration/codex-home-wsl.test.ts tests/test-layout.test.ts; plus the file-size ratchet test.
