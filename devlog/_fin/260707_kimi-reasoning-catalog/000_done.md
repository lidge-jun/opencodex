# Work-phase 5: kimi reasoning selector + stale catalog (260707) — DONE

Investigation: cxc map (codex-catalog/registry/reasoning-effort) + gpt-5.5 explorer
(Russell) with codex-rs picker evidence.

## Verdict on "kimi has no reasoning selector": PARTIALLY-INTENDED (not a proxy bug)
- codex picker shows the effort selector only when a catalog entry has
  supported_reasoning_levels choices (protocol/openai_models.rs:262-268; tui
  model_popups.rs:377-393 — empty choices + null default -> popup skipped).
- opencodex intentionally emits supported_reasoning_levels: [] for
  opencode-go/kimi-k2.7-code: it's in noReasoningModels because Kimi thinking is
  controlled by Kimi's `thinking` extension, NOT OpenAI reasoning_effort — official
  Kimi docs: thinking always on for k2.7-code, disabling errors, temperature/top_p
  locked (platform.kimi.ai docs, Tier-2 opened by explorer).
- Wire matches UI: mapReasoningEffort returns undefined -> adapter sends no
  reasoning_effort (tests assert this). Advertising fake levels would send a param
  the endpoint rejects.
- Follow-up (NOT this phase): real Kimi `thinking` extension support in
  openai-chat adapter + registry map, needs authenticated Zen Go probe evidence
  that opencode.ai accepts the thinking object.

## REAL bug found & fixed: live-catalog pollution from the test suite
- Symptom: ~/.codex/opencodex-catalog.json had only 8 models (gpt natives +
  deepseek/*) — all routed entries (kimi, glm, anthropic, xai...) MISSING, which is
  why the picker looked wrong beyond kimi.
- Root cause: tests/cli-provider.test.ts runCli() spawned ocx with inherited real
  CODEX_HOME; "provider add deepseek --sync" tests hit the LIVE proxy (config.port
  10100 matches) -> syncModelsToCodex rewrote the real catalog from the isolated
  OPENCODEX_HOME config (providers: openai+deepseek only) -> catalog wiped down to
  8 entries. Same class as the 260706 "test pollution" incident.
- Fix: tests/cli-provider.test.ts always sets an isolated CODEX_HOME in runCli.
- Recovery: `ocx sync` re-materialized 18 models (kimi/glm/anthropic back; verified
  levels: glm-5.2 low..xhigh default medium, kimi [] as designed).
- Regression proof: full suite re-run -> catalog still 18 models, kimi present.

## Verification
bun test ./tests/ -> 1550 pass / 0 fail; tsc exit 0; live catalog intact post-suite.
