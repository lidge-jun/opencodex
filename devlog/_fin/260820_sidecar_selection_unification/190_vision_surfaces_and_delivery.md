# 190 — Surfaces, live proof, delivery (wp4 cycle)

Depends on: 180.

## GUI

- Split the shared SidecarBackend (dashboard-shared.ts:62): web-search side
  keeps its server-provided backend strings (already emits xai/gemini/exa —
  stale type fixed by the split); vision side gets
  VisionBackend = "openai" | "anthropic" | "xai" | "gemini".
- visionSidecarBackendForModel fallback stays server-provenance-first;
  catalog inference (anthropic-vs-openai guess) only for legacy rows.
- claude-manual-env.ts SidecarOverride backend union widens for vision.
- No new dropdown UI: options arrive from visionModels server list already.

## CLI

- src/cli/agent.ts: usage already names xai|gemini; verify backend values
  pass through PUT unvalidated client-side (server gate authoritative);
  vision --list renders new backends' rows.

## Live proof (acceptance 3-5)

- GET /api/sidecar-settings on live :10100 shows visionModels containing
  xai/gemini rows (auth present on this machine for both — web-search rows
  prove it).
- PUT vision {backend:"xai", model:"grok-4.3"} → 200; PUT model grok-4
  (bare) → 400 provably-blind; restore original settings after proof.
- GUI screenshot of the vision dropdown listing Grok/Gemini rows.

## Delivery

- Small commits per layer (backends table / eligibility+gate / executors /
  GUI+CLI / tests+devlog), full bun run typecheck + bun run test green at
  final head, push directly to dev (user-authorized, no PR).
- devlog docs 160-190 land with the same push train; unit stays in _plan
  until the release train closes it.


## Delivery evidence (2026-08-22, wp4)

- Live dev server (commit 3ff19c33e, port 11100, copied auth home):
  - GET /api/sidecar-settings visionModels: 25 rows — legacy openai/anthropic
    sides + 17 namespaced [routed] rows (xai/grok-4.6,
    google-antigravity/gemini-3.7-flash, cursor/kimi-k3, zenmux/…,
    alibaba…/qwen3.8-max, …). Rule 2 confirmed live: no text-only rows.
  - PUT gates live: routed+xai/grok-4.6 → 200; routed+xai/grok-3 →
    400 provably-blind; openai+namespaced → 400 coherence.
  - GET after PUT reports the routed model verbatim
    ({"model":"xai/grok-4.6","backend":"routed"}) — fixed the legacy-collapse
    display bug found during this verification.
  - GUI screenshot: vision dropdown lists namespaced routed rows; current
    selection renders as xai/grok-4.6.
  - CLI: `ocx agent sidecar vision --list` prints the same 25 rows with
    [routed] backend tags (server-computed list, no drift).
  - LIVE describe e2e: POST /v1/chat/completions with a 64x64 red PNG to
    xai/grok-composer-2.5-fast (noVisionModels) with routed describer
    xai/grok-4.6 → main answer "red"; request history shows the inner
    grok-4.6 describe call followed by the outer composer call. (A 1x1 probe
    earlier failed with xai invalid_image min-8px — upstream constraint, not
    a pipeline defect; the graceful degradation path handled it and the main
    call still succeeded.)
- Verification-side effect handled: the 11100 dev server rewrote
  ~/.grok/config.toml to port 11100 during startup sync; restored to 10100
  via production `ocx ensure` and confirmed (27x base_url 10100, zero
  11100). Temp verify home moved aside (/tmp/trash-ocx-vision-verify-*).
- privacy:scan green; root+gui tsc clean; focused suites green (185 pass).
- Full-suite run at final head queued behind another worktree's runner
  (scripts/test.ts exclusive-run queue); recorded separately below when it
  lands.

