# WP3 — #320 native-auth-expiry-with-healthy-pool investigation (020)

Issue #320: with a healthy OpenAI/Codex pool and valid OAuth accounts, an
expired local Codex CLI native `auth.json` still opens a ChatGPT/Codex login
window when running `codex`, before the request reaches the OpenCodex proxy.
Secondary: after a Codex CLI npm update replaced the binary, the autostart shim
disappeared until `ocx codex-shim install` was re-run.

## Findings (Sol explorer, read-only; cite file:line)

Root cause = **upstream Codex behavior**, not a proxy bug:
- `codexAccountMode="pool"` is evaluated only AFTER a request reaches
  `/v1/responses` (`src/server/responses/core.ts:819`,
  `src/codex/auth-context.ts:100`). At that point OpenCodex picks + refreshes
  its managed credential and replaces the incoming native bearer
  (`auth-context.ts:142,181`, `account-store.ts:319`).
- The login window happens EARLIER, inside the upstream Codex executable.
  Loopback injection deliberately keeps Codex's built-in `openai` provider and
  only rewrites `openai_base_url` (`src/codex/inject.ts:41,105`); dedicated
  mode sets `requires_openai_auth=true` (`inject.ts:87`). So Codex validates its
  native `$CODEX_HOME/auth.json` before sending any HTTP.
- OpenCodex's own expiry check (`src/codex/main-account.ts:40`) only excludes
  the native main account from proxy-side rotation; it does not open the browser.
- Pool can serve without a usable native account once a request arrives; tests
  isolate an absent native auth.json while exercising pool creds
  (`tests/codex-auth-context.test.ts:39,99`).

Shim-disappears-after-npm-update:
- Install renames npm launcher to `*.opencodex-real`, writes wrapper at the
  original path, records both in `codex-shim.json` (`src/codex/shim.ts:1025`).
  npm update rewrites the launcher at that path, replacing the wrapper.
- Already self-repairs: every ordinary `ocx` command auto-restores before
  dispatch (`src/cli/index.ts:64`; restore logic `shim.ts:1043,1092`;
  `ocx status` eligible `src/cli/codex-shim-autorestore.ts:18`; test
  `tests/codex-shim-autorestore.test.ts:127`). A direct first `codex` call after
  replacement can't self-trigger (wrapper no longer runs); next `ocx` repairs it.
  `ocx service install` avoids launcher dependency for proxy startup.

## Decision

No minimal safe in-repo runtime fix for the native-login gate (suppressing it
would change Codex App/TUI account-gated semantics). Shim issue already fixed on
this branch. → **WP3 = investigate + English root-cause comment** (documentation
guidance), optionally a docs note that Pool creds are proxy-side and do not
satisfy Codex's pre-request native-login prerequisite.

## Comment to post (English)

> Thanks — this is two separate layers. In Pool mode, OpenCodex selects and
> refreshes its managed account only after Codex sends a request to
> `/v1/responses`; Codex CLI validates its own `auth.json` earlier, so an
> expired native login can open the login window before the proxy is contacted.
> That startup gate is upstream Codex's auth-required OpenAI provider behavior
> and can't be safely suppressed by the proxy without changing provider/UI
> semantics. The npm-update symptom is a launcher replacement; current dev code
> detects a previously tracked shim replacement and restores it on the next
> ordinary `ocx` command (manual fallback: `ocx codex-shim install`). For
> restart-safe operation independent of the launcher, use `ocx service install`.
> We'll document that Pool mode does not remove Codex's native-login prerequisite.

Terminal: DONE = comment posted on #320.
