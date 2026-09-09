# 030 — wp4: docs + push + PR

## Files
- `docs-site/src/content/docs/troubleshooting/voice*.md` (or the page that documents GPT-Live / realtime):
  add "sideband 404 after Codex 0.146+ (2026-07-28)" section — cause, that `ocx start` now writes
  `experimental_realtime_ws_base_url`, how to verify (`grep experimental_realtime_ws_base_url ~/.codex/config.toml`,
  a `gpt-live` `101` row in usage), and the manual line for hand-written configs.
- Korean/other locales: only if the English page has a translated twin; keep them from contradicting.
- `devlog/_plan/260903_voice_sideband_regression/040_d_record.md` with the terminal outcome.

## Git
- branch `codex/voice-sideband-override` off current HEAD (162d11e18 == origin/dev).
- commits per B step; push `--no-verify` (authorized), PR against `dev` using
  `.github/PULL_REQUEST_TEMPLATE.md` (Summary / Verification / Checklist), no `gui` mention.
- After push: `gh pr checks <n>` / workflow runs for the EXACT head SHA; report status.
- Stacked PR only if wp2 and wp3 need separate review; default single PR since wp3 is small.
