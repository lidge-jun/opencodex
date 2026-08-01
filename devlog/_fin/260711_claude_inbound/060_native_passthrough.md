# 060 — Subscription-preserving launch + native Anthropic passthrough

User follow-up after live smoke: (1) `ocx claude` triggered "claude.ai connectors
are disabled because ANTHROPIC_API_KEY or another auth source is set", (2) asked
for a NATIVE pierce for claude models, referencing KarpelesLab/teamclaude.

## Evidence (sol explorer, Tier 2 — full ledger in agent return)

- Connectors/`/schedule`/Remote Control are disabled when ANY of
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` is set.
- `ANTHROPIC_BASE_URL` ALONE preserves subscription OAuth — Claude Code keeps its
  claude.ai login and sends `Authorization: Bearer sk-ant-oat…` to the custom
  base URL. Proven by teamclaude `--no-mitm` (source comment: "Only set
  ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token") AND Vercel's
  official "With Claude Code Max" gateway docs.
- teamclaude = transparent Anthropic-native passthrough + multi-account rotator;
  forwards ALL end-to-end headers (strips hop-by-hop, x-api-key, accept-encoding)
  and substitutes ITS account auth. We differ deliberately: v1 forwards the
  CALLER's own credential (billing identity stays the user's genuine Claude Code
  requests — avoids the CLIProxyAPI #2599 usage-reclassification pitfall).
- No official fixed header allowlist exists → forward everything end-to-end
  (incl. anthropic-beta/version, user-agent, x-app, x-claude-code-*).

## Shipped

1. **Launcher** (`src/cli/claude.ts`): `ANTHROPIC_AUTH_TOKEN` is injected ONLY
   when `config.apiKeys` is non-empty (proxy admission actually required).
   Default loopback launch sets base URL + discovery flag only → warning gone,
   subscription login + connectors preserved.
2. **Native passthrough** (`src/server/claude-messages.ts`): requests whose model
   matches `/^(claude|anthropic)/i`, carry an `sk-ant-*` credential (Bearer or
   x-api-key), and hit NO alias/modelMap are forwarded verbatim (re-serialized
   JSON body, all end-to-end headers, query string) to
   `claudeCode.anthropicBaseUrl ?? https://api.anthropic.com`. SSE relayed
   untouched with an Anthropic-vocab log tap (usage incl. cache split, provider
   `anthropic-native`); non-stream relayed with usage from the JSON body.
   count_tokens passes through under the same condition. Opt-out:
   `claudeCode.nativePassthrough: false`.
3. Mixed sessions now work: picker aliases -> translate-and-replay routing;
   genuine claude models -> subscription-native passthrough; same daemon.
4. Docs (en/ko/zh-cn) + GUI manual-env block + i18n hints updated; tests:
   `tests/claude-native-passthrough.test.ts` (verbatim body incl. thinking
   signature + cache_control, header forwarding, log row, negative cases,
   opt-out) + launcher env tests updated.

## Verification

- Suite 2152 pass / 1 pre-existing env fail (install-scripts wants node on PATH);
  tsc clean; gui + docs builds clean.
- NEEDS_HUMAN: rerun `ocx claude` (proxy restarted from this build) — expect no
  connectors warning; `/model` claude models bill the subscription natively;
  aliases still route.
