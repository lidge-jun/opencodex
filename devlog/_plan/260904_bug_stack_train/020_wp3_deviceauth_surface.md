# 020 — wp3: deviceauth surface (stack layer 2)

Branch: `codex/deviceauth-surface`, based on `codex/deviceauth-core`.
Thesis: make the grant reachable. Without this layer the core is unreachable from any
user-facing path, because `openai|codex|chatgpt` go through the Codex-auth API, which
drops `deviceCode` from the start DTO at `src/codex/auth-api.ts:2440` and opens the
authorization URL at `:2206` (conditional on `shouldOpenBrowserForLogin`, which already
honors an explicit/configured false at `src/oauth/open-browser-choice.ts:20` — the gap is
that a device flow is not itself a reason to skip the open).

## Files

- MODIFY `src/codex/auth-api.ts` — accept `device?: boolean` on login start, pass
  `flow: "device"` into the chatgpt login, return `deviceCode` in the start DTO, and
  suppress the server-side browser open when `deviceCode` is present (mirroring
  `src/server/management/oauth-account-routes.ts:185`).
- MODIFY `src/cli/account-auth.ts` — add `--device`; include it in the login body;
  print `Device code: <code>` in the Codex pre-poll block; preserve it under
  `--no-wait --json`.
- MODIFY `src/cli/capabilities.ts` — declare the flag.
- MODIFY `gui/src/components/use-add-codex-account-oauth.ts` — keep `deviceCode` and
  `instructions` on the start DTO (dropped today at `:148`) and request device mode.
- MODIFY `gui/src/components/add-codex-account-reducer.ts` — carry both fields in state.
- MODIFY `gui/src/components/add-codex-account-waiting-step.tsx` — pass them to
  `LoginHint` (today it passes only `url` at `:38`). The shared renderer at
  `gui/src/components/login-url-block.tsx:42-47,73-107` is already device-capable, so no
  new UI component is needed.
- REGENERATE `skills/ocx/references/01_management_surface.md` via `bun run skill:surface`
  (gated by `tests/skill-ocx.test.ts`).
- MODIFY `docs-site/` provider/account docs (English source; do not let locales contradict).

## Poll budget (audit blocker 2)

The device grant lives 15 minutes, but both existing poll budgets stop at five:
Codex-auth polls 150 x 2s and then records an error (`src/codex/auth-api.ts:2214,2414`),
and the CLI independently stops at the same 150 x 2s (`src/cli/account-auth.ts:123`).
Shipping the grant without widening these would advertise a 15-minute window that
dies at minute five — exactly the headless case this feature exists for, where the
operator walks to another device to enter the code.

Both budgets are raised for the device flow, and a test proves a login completing
after minute five still succeeds (fake timers; no real waiting).

## Security review gate (audit finding 4)

`src/oauth/`, `src/codex/auth-api.ts`, and `src/cli/account-auth.ts` are restricted
authentication surfaces (`.github/scripts/pr-sponsored-surface.cjs:24`) and require
explicit security review per `MAINTAINERS.md:60`. Both deviceauth PRs carry that
requirement in their description; neither is merged as routine.

Explicitly NOT done: repurposing `--code` as device user-code input. The device user
code is entered at `auth.openai.com`, while `account code` submits callback
authorization material to a different endpoint (`src/codex/auth-api.ts:2457-2472`).
Conflating them would silently break the existing paste fallback.

## Tests

- `tests/codex-auth-api.test.ts`: device login returns `deviceCode` and does not open a URL.
- `tests/cli-account.test.ts`: `--device` prints URL + device code + flow id; `--no-wait --json` preserves it.
- `tests/codex-auth-api.test.ts`: a device login that completes after minute five still succeeds.
- `tests/cli-account.test.ts`: with fake timers, a normal (polling) `--device` login completes
  after minute five. The `--no-wait` case bypasses polling and does not cover this.
- `gui/tests/add-codex-account-device.test.tsx`: the start request carries `device: true`,
  and the waiting step renders the device code and verification URL.

Focused: `bun test tests/codex-auth-api.test.ts tests/cli-account.test.ts tests/skill-ocx.test.ts`
plus the single focused GUI test file. No repository-wide suite.
