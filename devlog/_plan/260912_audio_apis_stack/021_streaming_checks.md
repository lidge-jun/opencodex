# Streaming outcome and next layer

Functional layer: PASS at `011f2dff5ca3667b88f090fe711c4b2c77efd190`, PR #4392 onto
`codex/audio-transcription` (`71e22d967ffafbd3492935c299623c9127eaf17b`).
Remote run [34687731903](https://github.com/lidge-jun/opencodex/actions/runs/34687731903)
tested merge `df1c26d1`.

- Audio client: 11 passing cases, job 103537614446.
- File transcription: 24 passing cases, job 103537614468.
- Dictation/voice ingress and lifecycle: 11 passing cases, job 103537614422.
- Call bindings: four passing cases on Linux and macOS, job 103537614428.
- Gates: typecheck, 1,979 dashboard tests, privacy, skill surface, release syntax
  and CLI smoke passed, job 103537614453. Dashboard build skipped for this layer.
- Independent inherited source reviews: Ramanujan closure PASS; Feynman final
  PASS after native platform-key compatibility and neutral WebSocket accounting
  corrections. No unresolved blocking finding in these bounded reviews.

All checks above ran remotely. Local product tests, typecheck, build and install
were NOT RUN for this layer, per owner instruction. Pushes used `--no-verify`.
No real upstream audio or personal recording was used.

## Separate baseline failures

Linux test 2/4 (103537614443) and macOS 2/2 (103537614422) still report
`tests/codex-integration/codex-journal.test.ts:170` (failed versus skipped restore)
and `:528` (routing retained after compensated failed restore). These failures
were observed before the final audio changes. They are recorded, not included
in this feature's repair scope, following the owner's explicit decision.
An earlier run also showed the stale-process status assertion at
`tests/cli/cli-status-json.test.ts:893`; do not claim it repaired without evidence.
Bun batch crashes that recovered through CI singleton retries are not runtime-fix
evidence. Whole-run green and merge readiness are not claimed.

## Next

Proceed to wp3: configured endpoint metadata, separate Dictation and Live Voice
controls, synthetic browser QA of the CI-built dashboard, and ordinary stacked
publication. Configuration is not entitlement or observed connectivity. Leave
all PRs open; aggregate baseline failures remain a separate publication note.
