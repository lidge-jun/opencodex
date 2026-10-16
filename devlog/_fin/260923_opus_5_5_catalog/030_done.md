# 030 Done (wp1)

## Conclusion

Claude Opus 5.5 (`claude-opus-5-5`) now carries its official price, 1M context, 128K output,
text+image input and the low..max effort ladder everywhere Claude Opus 5 is represented and an
upstream source shows Opus 5.5 exists. Commit `9cff9b8c52` on `codex/opus-5-5-catalog`.

## What changed

- Anthropic seed (`model-seeds.ts`): the id and its 1M window; the seed drives the effort ladder
  and modalities the live picker was missing.
- Metadata snapshot and regenerated table: anthropic, six Bedrock ids, openrouter, vercel (+fast),
  kilo, venice.
- Price overlays: anthropic, anthropic-apikey, cursor (verified), devin and devin-cli (derived).
  Opus 5 overlays now cite the published Anthropic price.
- Cursor capability, effort tiers and thinking families; Devin seed and context window; docs.

## Evidence

- Receipt `.codexclaw/evidence/01a0ca42-e654-76f1-a399-b6003105d628/test-receipt.json`:
  1542 pass / 0 fail across 73 files at `9cff9b8c52`. `bun run typecheck` exit 0.
- Verifier subagent (gpt-5.6-sol): cursor 1309 pass, provider/usage 215 pass, layout 18 pass,
  ratchet 9 pass, `structure:check` and `privacy:scan` pass.
- Fresh-process probe: anthropic, anthropic-native `claude-opus-5.5`, cursor
  `claude-opus-5-5-thinking-high`, devin, openrouter resolve to 4 / 20 / 0.2 / 5; Bedrock US to
  4.4 / 22 / 0.22 / 5.5.

## What did not improve

- `bun run test:changed` in this worktree: 896 failures, all from the test-home guard refusing
  cleanup under `/Users/jun/.codex` (this checkout lives in `~/.codex/worktrees`). No failure
  touches a changed file. Hosted CI is the real full-suite signal.
- Residuals from 020: Cursor Fast rows price at base; forced `tool_choice` on Opus 5.5 returns 400
  through the Anthropic adapter; the running proxy needs a restart to load the new rows.
- Kiro, GitHub Copilot and opencode-zen stay without Opus 5.5 until their catalogs list it.

## Next

No further work-phase under this goal. Push/PR and service restart need separate approval.

