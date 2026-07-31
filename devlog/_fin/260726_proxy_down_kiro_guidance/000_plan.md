# 260726 — Proxy-down restart guidance + Kiro CLI prerequisite guidance

## Loop spec

- Loop archetype: spec-satisfaction repair (single work-phase, C2).
- Trigger: user report — Codex app shows `stream disconnected before completion:
  error sending request for url (http://127.0.0.1:10100/v1/responses)` and users do
  not realize the ocx proxy is simply off; separately, Kiro connection requires the
  Kiro CLI installed but no surface says so.
- Goal (user-visible outcome): when the proxy is down, every ocx-owned surface tells
  the user to restart it with `ocx start` or `ocx service`; Kiro login surfaces state
  the Kiro CLI prerequisite (install + `kiro-cli login`) before the token fallbacks.
- Non-goals: rewriting Codex app's own error box (impossible — nothing listens on the
  port when the proxy is down); a dead-man's-switch listener; tray changes; provider
  logic changes.
- Verifier: `bun run typecheck`, focused bun tests (doctor, kiro-oauth),
  `bun run privacy:scan`, full `bun run test` before D.
- Stop condition: all surfaces land + gates green, or a blocker is named.
- Memory artifact: this unit's docs + git history.
- Expected terminal outcomes: DONE / NOOP (if a surface already says it) / BLOCKED.
- Escalation condition: any need to touch service lifecycle or release automation.

## Ground truth (read during P)

- Proxy-down errors are rendered by the *client* (Codex core reqwest, Claude Code) —
  ocx cannot intercept them because nothing listens on 127.0.0.1:10100. Achievable:
  guidance on ocx-owned surfaces + docs matching the exact error text.
- CLI users are auto-healed by the codex shim (`ocx ensure` on every `codex` launch);
  the Codex desktop app is NOT shim-covered (`shimCoverage: "cli-only"`,
  src/codex/autostart-health.ts:69-71) — app users are exactly who hits the screenshot.
- Existing surfaces:
  - `ocx status` prints `❌ Proxy: not running` with no next step (src/cli/index.ts:~596).
  - `ocx doctor` prints "no running ocx proxy process found" in a sub-section but no
    actionable hint in the Hints section (src/cli/doctor.ts).
  - `ocx stop` prints stop results but never warns that client requests will now fail
    (src/cli/index.ts handleStop tail).
  - docs-site has no proxy-connection troubleshooting section;
    `guides/codex-integration.md` has a "Catalog troubleshooting" anchor to sit beside.
- Kiro: `ocx login kiro` is import-first (src/oauth/kiro.ts loginKiro). Missing-token
  guidance says "Run `kiro-cli login` first" but never says kiro-cli must be INSTALLED
  (official install: `curl -fsSL https://cli.kiro.dev/install | bash`,
  https://kiro.dev/docs/cli/installation/ — verified 2026-07-26). Registry preset note
  renders in the GUI add-provider OAuth pane (gui/src/components/add-provider-oauth-pane.tsx:40).
  Instructions returned by the management API render in the GUI paste pane.
- Tests: tests/kiro-oauth.test.ts:250 asserts /no token found/i (stays compatible);
  tests/doctor.test.ts unit-tests exported doctor helpers.

## File change map (IN)

1. `src/cli/index.ts` — status render: when proxy not running, print restart hint
   (`ocx start` / `ocx service install`); `case "stop"` call site: warn that
   Codex/Claude requests now fail until restart (audit-amended: NOT inside
   handleStop — restart/tray-restart callers re-start immediately).
2. `src/cli/doctor.ts` — new exported pure helper `proxyDownRestartHint(...)` + wire a
   Hints-section entry when no live proxy is found; include the exact symptom string
   `error sending request for url (http://127.0.0.1:<port>/v1/responses)`.
3. `src/oauth/kiro.ts` — onAuth instructions + final throw: add kiro-cli install
   prerequisite (install command + `kiro-cli login`) before token fallbacks.
4. `src/providers/registry.ts` — kiro `note`: state the Kiro CLI requirement.
5. `docs-site/src/content/docs/guides/codex-integration.md` (+ ko/ja/zh-cn/ru) —
   new short "Proxy connection errors" section: symptom text, meaning, fix commands.
6. `docs-site/src/content/docs/guides/providers.md` (+ ko/ja/zh-cn/ru) — kiro rows:
   prerequisite sentence (install + `kiro-cli login`, token fallbacks unchanged).
7. `tests/kiro-oauth.test.ts` — assert install guidance in the error message.
8. `tests/doctor.test.ts` — unit-test `proxyDownRestartHint` wording/gating.

## Scope boundary (OUT)

- No service lifecycle, workflow, or release automation changes.
- No client-side (Codex app/CLI) patching.
- No new listener/watchdog processes.
- No kiro adapter/wire changes.

## Accept criteria (with activation scenarios)

- AC1: `ocx status` with proxy down prints a line containing `ocx start` and
  `ocx service`. Activation: run status render with no live proxy (helper level).
- AC2: `ocx doctor` hints include the restart hint ONLY when no live proxy is found;
  text names the symptom substring `error sending request for url` and both commands.
  Activation: unit-test `proxyDownRestartHint` for down/up/service-viable cases.
- AC3: `ocx stop` success path prints the fail-until-restart warning. Activation: code
  path review + existing stop tests stay green (tests/stale-state-purge, grok-lifecycle).
- AC4: `loginKiro` throw message and onAuth instructions name the install command
  `cli.kiro.dev/install` and `kiro-cli login`. Activation: tests/kiro-oauth.test.ts.
- AC5: registry kiro note mentions the Kiro CLI requirement; docs en+4 locales carry
  the new sections; `bun run privacy:scan`, `bun run typecheck`, `bun run test` green.
