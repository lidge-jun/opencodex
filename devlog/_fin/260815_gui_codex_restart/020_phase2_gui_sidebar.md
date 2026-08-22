# 020 — Phase 2: sidebar action row (stop proxy + restart Codex)

Depends on: phase 1's `CODEX_RESTART_PATH`, `CodexRestartResponse`, and
`isCodexRestartResponse`.
Produces: the client helper phase 3 reuses.
Rejected alternatives and reasoning: `001_design_alternatives.md` §3.

## Scope

| Path | Action |
|---|---|
| `gui/src/codex-restart.ts` | NEW |
| `gui/src/App.tsx` | MODIFY |
| `gui/src/styles.css` | MODIFY |
| `gui/src/i18n/{en,de,ko,zh,zh-TW,ru,ja,tr}.ts` | MODIFY |
| `gui/tests/codex-restart.test.ts` | NEW |
| `gui/tests/app-sidebar-actions.test.ts` | NEW |

OUT: models tab (phase 3), the memory card's proxy-restart UX, `gui/src/icons.tsx`
(`IconPower` `:35` and `IconRefresh` `:23` both already exist).

## Invariants

1. A 2xx body is validated with `isCodexRestartResponse` before use. A type
   assertion is not validation, and the handler indexes `.surviving.length`.
2. A dropped connection is a **failure** here, unlike `stop-proxy.ts` where the
   socket is expected to die (`gui/src/stop-proxy.ts:37-40`).
3. Both actions are confirm-gated. This can interrupt an in-flight Codex turn — the
   consent the startup path refuses to assume
   (`src/codex/app-server-processes.ts:772-780`).
4. Mobile touch targets stay at or above 44x44, matching the existing mobile stop
   rule (`gui/src/styles.css:2115`).
5. All eight locales change together. Parity is enforced by
   `Record<TKey, string>` at build time (`gui/src/i18n/en.ts:2055`,
   `gui/src/i18n/ko.ts:6`, registry `gui/src/i18n/shared.ts:6-14`) — **not** by
   `lint:i18n`, which is an oxlint pass over UI files (`gui/package.json:11`).

## NEW `gui/src/codex-restart.ts`

Type-only import across the project boundary is already established practice
(`gui/src/combo-workspace-data.ts:6`, resolvable under
`gui/tsconfig.app.json:11-24`).

```ts
import type { CodexRestartCode, CodexRestartResponse } from "../../src/lib/codex-restart-contract";
import { isCodexRestartResponse } from "../../src/lib/codex-restart-contract";

export interface CodexRestartOutcome {
  ok: boolean;
  result?: CodexRestartResponse;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CodexRestartOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  formatFailure?: (status: number) => string;
  formatUnreachable?: () => string;
  formatMalformed?: () => string;
}

export async function requestCodexRestart(
  apiBase: string,
  options: CodexRestartOptions = {},
): Promise<CodexRestartOutcome> {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    formatFailure = status => \`Failed to restart Codex (HTTP \${status}).\`,
    formatUnreachable = () => "Could not reach the proxy.",
    formatMalformed = () => "The proxy returned an unexpected response.",
  } = options;

  let response: Response;
  try {
    response = await fetchFn(\`\${apiBase}/api/system/codex-restart\`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Unlike stop-proxy, a dropped connection here is a real failure: this route
    // does not kill the process serving it, so silence means something broke.
    return { ok: false, message: formatUnreachable() };
  }

  if (!response.ok) return { ok: false, message: formatFailure(response.status) };

  const payload = await response.json().catch(() => null) as unknown;
  // A parseable 2xx body of the wrong shape must not reach the caller: the handler
  // indexes .surviving.length and would throw inside an event handler.
  if (!isCodexRestartResponse(payload)) return { ok: false, message: formatMalformed() };
  return { ok: true, result: payload };
}
```

## MODIFY `gui/src/App.tsx`

The handler comes from the shared hook defined at the end of this document:

```tsx
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(API_BASE);
```

The confirm is not ceremony: this can interrupt an in-flight Codex turn, which is
precisely the consent the startup path refuses to assume for the user
(`src/codex/app-server-processes.ts:772-780`).

Desktop: replace `:267-270` with

```tsx
          <div className="sidebar-action-row">
            <span className="sidebar-action-label">{t("dash.actions")}</span>
            <div className="sidebar-action-orbs">
              <button type="button" className="sidebar-orb sidebar-orb--danger"
                onClick={handleStop} disabled={stopping}
                aria-label={t("dash.stop")} title={t("dash.stop")}>
                <IconPower />
              </button>
              <button type="button" className="sidebar-orb"
                onClick={handleCodexRestart} disabled={codexRestarting}
                aria-label={t("dash.codexRestart")} title={t("dash.codexRestart")}>
                <IconRefresh />
              </button>
            </div>
          </div>
```

Mobile: replace the single stop button (`:205-208`) with the same two-button group
wrapped in `<div className="mobile-topbar-actions">`, so both surfaces carry the
same capability.

## MODIFY `gui/src/styles.css`

Beside `.sidebar-github-row` (`:333`):

```css
.sidebar-action-row { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 4px 2px; }
.sidebar-action-label { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--muted); }
.sidebar-action-orbs { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.sidebar-orb--danger { color: var(--red); }
.sidebar-orb--danger:hover:not(:disabled) { background: var(--red-soft); color: var(--red); border-color: var(--red); }
.sidebar-orb:disabled { opacity: 0.5; cursor: default; }
```

`--red` and `--red-soft` are the tokens `.stop-toggle` already uses (`:384-386`).

Inside the mobile media block that currently widens `.mobile-topbar .stop-toggle`
(`:2115`), so neither orb shrinks below the existing touch target:

```css
  .mobile-topbar-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .mobile-topbar-actions .sidebar-orb {
    width: 44px; height: 44px; flex: 0 0 44px; min-width: 44px; min-height: 44px;
  }
  .mobile-topbar-actions .sidebar-orb svg { width: 18px; height: 18px; }
```

## MODIFY eight `gui/src/i18n/*.ts`

| Key | English |
|---|---|
| `dash.actions` | Proxy |
| `dash.codexRestart` | Restart Codex |
| `dash.codexRestarting` | Restarting… |
| `dash.codexRestartConfirm` | Restart Codex app-servers? Any Codex turn in progress will be interrupted. |
| `dash.codexRestartDone` | Stopped {count} Codex app-server(s). Reopen Codex to load the current model list. |
| `dash.codexRestartNothing` | No Codex app-server is running. The next launch reads the current model list. |
| `dash.codexRestartUnknown` | Could not list processes, so nothing was stopped. |
| `dash.codexRestartPartial` | {count} app-server(s) did not exit. Stop them manually if the model list stays stale. |
| `dash.codexRestartFailed` | Failed to restart Codex (HTTP {status}). |
| `dash.codexRestartUnreachable` | Could not reach the proxy. |
| `dash.codexRestartMalformed` | The proxy returned an unexpected response. |

Korean follows the existing register in `ko.ts`: plain, no translationese.

## Tests

`gui/tests/codex-restart.test.ts`:

| Scenario | Trigger | Observable proof |
|---|---|---|
| success | valid contract body | `ok === true`, result forwarded |
| non-2xx | 500 | `ok === false`, formatFailure text |
| network throw | `fetchFn` rejects | `ok === false`, formatUnreachable text |
| unparseable body | 200 with invalid JSON | `ok === false`, formatMalformed text |
| **parseable wrong shape** | 200 with `{"success":true}` | `ok === false`, formatMalformed text |
| wrong-typed pid array | `stopped: ["a"]` | `ok === false` |

`gui/tests/app-sidebar-actions.test.ts`: both orbs present with aria-labels on
desktop and mobile, restart orb disabled while pending, declined `confirm` issues
zero fetch calls, and each of the four codes produces its own message.

No existing GUI test asserts on `.stop-toggle` markup — `gui/tests/app-stop.test.ts`
inspects the handler body (`:56-68`) — so replacing the button breaks nothing.

## Accept criteria

1. Both orbs render on desktop and mobile; mobile targets are at least 44x44.
2. Declining the confirm sends no request (stub `confirm` false, assert zero fetches).
3. Each of the four response codes produces a distinct message (four stubbed
   responses, four assertions).
4. A parseable but wrong-shaped 2xx body is treated as failure.
5. `cd gui && bun run lint && bun test && bun run build` green.
6. Render grounding: build, load the dashboard, screenshot the sidebar foot and the
   mobile top bar, and read both screenshots back (C-RENDER-GROUNDING-01).

## Verifier commands

| Command | Reads this change? |
|---|---|
| `cd gui && bun test tests/codex-restart.test.ts tests/app-sidebar-actions.test.ts` | yes — direct arguments |
| `cd gui && bun run build` | yes — `tsc -b` is what enforces locale parity |
| `cd gui && bun run lint` | yes — oxlint over `.` |
| `cd gui && bun run lint:i18n` | partially — oxlint over listed UI files; **not** a parity gate |

## Bypass record

- Tier: E3 (build-enforced parity, test-enforced behavior).
- Executing surface: `bun run build` and `bun test`, locally and in CI.
- Known bypass: none for locale *presence* — the `Record<TKey, string>` type makes
  it structural.
- Residual risk: a translation can be wrong without being missing.
- Wording: locale presence is enforced; locale quality is an early warning only.
  Final enforcement layer for quality: human review.


## Shared hook (consumed by phase 3)

`gui/src/codex-restart.ts` also exports the handler both surfaces use, so the
four-branch message mapping exists once:

```tsx
import { useCallback, useState } from "react";
import { useI18n } from "./i18n/shared";

export interface CodexRestartController {
  restarting: boolean;
  /** Resolves to the response code, or null when the user declined or the call failed. */
  restart: () => Promise<CodexRestartCode | null>;
}

export function useCodexRestart(apiBase: string): CodexRestartController {
  const { t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const restart = useCallback(async (): Promise<CodexRestartCode | null> => {
    if (!confirm(t("dash.codexRestartConfirm"))) return null;
    setRestarting(true);
    const outcome = await requestCodexRestart(apiBase, {
      formatFailure: status => t("dash.codexRestartFailed", { status: String(status) }),
      formatUnreachable: () => t("dash.codexRestartUnreachable"),
      formatMalformed: () => t("dash.codexRestartMalformed"),
    });
    setRestarting(false);
    if (!outcome.ok || !outcome.result) { alert(outcome.message); return null; }
    const r = outcome.result;
    if (r.code === "stopped") alert(t("dash.codexRestartDone", { count: r.stopped.length }));
    else if (r.code === "nothing_running") alert(t("dash.codexRestartNothing"));
    else if (r.code === "enumeration_unavailable") alert(t("dash.codexRestartUnknown"));
    else alert(t("dash.codexRestartPartial", { count: r.surviving.length }));
    return r.code;
  }, [apiBase, t]);
  return { restarting, restart };
}
```

Returning the code rather than a boolean matters for phase 3. A race where the
classified app-server exits on its own between classification and signalling comes
back as `nothing_running` with `success: true`; a boolean `stopped`-only signal
would leave the staleness banner on screen after a successful outcome. Both
`stopped` and `nothing_running` are refresh-worthy.

`useI18n` is exported from `gui/src/i18n/shared.ts:70`.

`App.tsx` uses `const { restarting: codexRestarting, restart: handleCodexRestart } =
useCodexRestart(API_BASE);` instead of an inline handler. The transport function
stays a plain async function beside the hook so non-component callers can use it.

