# 030 — Phase 3: models tab action + staleness banner

Depends on: phase 1's `CODEX_APP_SERVER_STATE_PATH` and phase 2's
`requestCodexRestart` plus the `dash.codexRestart*` keys.
Rejected alternatives and reasoning: `001_design_alternatives.md` §2.

## Scope

| Path | Action |
|---|---|
| `gui/src/codex-app-server-state.ts` | NEW |
| `gui/src/components/codex-stale-banner.tsx` | NEW |
| `gui/src/pages/Models.tsx` | MODIFY |
| `gui/src/codex-restart.ts` | MODIFY (export the shared hook from phase 2) |
| `gui/src/styles.css` | MODIFY |
| `gui/src/i18n/{en,de,ko,zh,zh-TW,ru,ja,tr}.ts` | MODIFY |
| `gui/tests/codex-stale-banner.test.tsx` | NEW |

OUT: sidebar (phase 2), backend (phase 1), the models catalog list rendering.

## Invariants

1. **Name collision.** `Models.tsx` already binds `catalogState` at `:331` to the
   `useDataSurface` resource state of `/api/catalog` (`:316-331`). That is an
   unrelated concept. This phase uses `appServerState` and never reuses the other
   name.
2. **No timer.** The reading is fetched once on mount and on explicit user refresh.
   Enumeration shells out to `ps`, procfs, or PowerShell CIM; a polling banner would
   be exactly the hidden work this workspace avoids (its own catalog poll is gated on
   tab activity, `:325-330`).
3. Banner renders for `stale` only. `fresh`, `not_running`, and `unknown` render
   nothing — telling a user "we could not tell" on a models page is noise, and the
   sidebar control stays available regardless.
4. `GET /api/system/codex-app-server` is the source, not `/api/subagent-models`;
   the latter is owned by the subagents page (`gui/src/pages/Subagents.tsx:116-125`)
   and assembles a roster this banner does not use.

## NEW `gui/src/codex-app-server-state.ts`

```ts
import type { CodexAppServerStateResponse } from "../../src/lib/codex-restart-contract";
import { isCodexAppServerStateResponse } from "../../src/lib/codex-restart-contract";

export interface AppServerStateOutcome {
  state: CodexAppServerStateResponse["state"] | null;
  runningCount: number;
}

const UNKNOWN: AppServerStateOutcome = { state: null, runningCount: 0 };

/** Null state means "render nothing" — never a guess. */
export async function fetchCodexAppServerState(
  apiBase: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AppServerStateOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn(\`\${apiBase}/api/system/codex-app-server\`, {
      signal: options.signal,
    });
    if (!res.ok) return UNKNOWN;
    const body = await res.json().catch(() => null) as unknown;
    // Reuse the contract's guard rather than re-deriving a weaker one here.
    if (!isCodexAppServerStateResponse(body)) return UNKNOWN;
    return { state: body.state, runningCount: body.runningCount };
  } catch {
    // Includes AbortError on unmount. A failed reading renders nothing rather than
    // asserting a state the proxy never reported.
    return UNKNOWN;
  }
}
```

## NEW `gui/src/components/codex-stale-banner.tsx`

```tsx
import { useI18n } from "../i18n/shared";
import type { CodexRestartController } from "../codex-restart";
import type { AppServerStateOutcome } from "../codex-app-server-state";

export function CodexStaleBanner(props: {
  state: AppServerStateOutcome["state"];
  controller: CodexRestartController;
  onRestarted: () => void;
}) {
  const { t } = useI18n();
  if (props.state !== "stale") return null;
  return (
    <div className="codex-stale-banner" role="status">
      <span className="codex-stale-banner-text">{t("models.staleBanner")}</span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={props.controller.restarting}
        onClick={() => {
          void props.controller.restart().then(code => {
            // Both outcomes mean no stale app-server remains: "stopped" is the
            // signal succeeding, "nothing_running" is the target having already
            // exited between classification and signalling. Refreshing on only
            // the first would leave the banner up after a successful race.
            if (code === "stopped" || code === "nothing_running") props.onRestarted();
          });
        }}
      >
        {props.controller.restarting ? t("dash.codexRestarting") : t("dash.codexRestart")}
      </button>
    </div>
  );
}
```

`useI18n` is exported from `gui/src/i18n/shared.ts:70` and is the hook the rest of
the GUI uses. `CodexStaleBanner` owns no pending state and no transport: the Models page owns one
`useCodexRestart` controller, so its head button and this banner share a single
pending state.

The sidebar in `App.tsx` holds a **separate** controller instance. Both controls can
be on screen at once and they do not share a disabled state, so a user can press the
sidebar button while the models request is still in flight. That is accepted rather
than prevented: `restartCodexAppServers` re-resolves each pid and requires the same
pid+command-line identity immediately before signalling
(`src/codex/app-server-processes.ts:676-682`), so a second overlapping request
cannot signal a replacement app-server that reused a pid. The residual cost of a
duplicate request is a second SIGTERM to a process already exiting, and a second
confirm dialog the user must answer.

The confirm copy is shared with phase 2 on purpose: one action, one consent
sentence, two entry points.

## MODIFY `gui/src/pages/Models.tsx`

State beside the existing resource wiring:

```tsx
  const [appServerState, setAppServerState] = useState<AppServerStateOutcome["state"]>(null);

  const reloadAppServerState = useCallback((signal?: AbortSignal) => {
    void fetchCodexAppServerState(apiBase, { signal })
      .then(outcome => { if (!signal?.aborted) setAppServerState(outcome.state); });
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    reloadAppServerState(controller.signal);
    return () => controller.abort();
  }, [reloadAppServerState]);
```

Head and banner at `:1714-1726`:

```tsx
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <div className="page-head-actions">
          <button type="button" className="sidebar-orb"
            onClick={handleCodexRestart} disabled={codexRestarting}
            aria-label={t("dash.codexRestart")} title={t("dash.codexRestart")}>
            <IconRefresh />
          </button>
        </div>
      </div>
      <CodexStaleBanner
        state={appServerState}
        controller={{ restarting: codexRestarting, restart: handleCodexRestart }}
        onRestarted={() => reloadAppServerState()}
      />
      <ModelsTabStrip tab={tab} onSelect={selectTab} meta={tabMeta} />
```

`.page-head` is already `justify-content: space-between`
(`gui/src/styles.css:436`), so it accepts a trailing action group without layout
work. The banner sits above `ModelsTabStrip` so it shows on every models sub-tab.

Explicitly rejected: placing the control inside `ModelsTabStrip`
(`gui/src/pages/models-tab-strip.tsx:64`). Every child there is `role="tab"`; a
mutation button inside a `tablist` breaks the ARIA contract.

`Models` receives `apiBase` as a prop (`gui/src/pages/Models.tsx:94`); there is no
`API_BASE` binding in this file, so every call site uses the prop.

The head button reuses phase 2's `useCodexRestart` hook rather than duplicating the
four-branch message mapping:

```tsx
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(apiBase);
```

The banner takes the same controller by prop so the page owns one pending state:

```tsx
  <CodexStaleBanner
    state={appServerState}
    controller={{ restarting: codexRestarting, restart: handleCodexRestart }}
    onRestarted={() => reloadAppServerState()}
  />
```

`CodexStaleBanner` therefore takes `{ state, controller, onRestarted }` instead of
`apiBase`, calls `controller.restart()`, and invokes `onRestarted()` when it
resolves true. Its own `busy` state is dropped in favor of `controller.restarting`.

## MODIFY `gui/src/styles.css`

```css
.page-head-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.codex-stale-banner {
  display: flex; align-items: center; gap: 10px;
  margin: 8px 0 4px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--raised); color: var(--text);
}
.codex-stale-banner-text { flex: 1 1 auto; min-width: 0; }
```

Existing tokens only. Confirm `--radius` and `--raised` against the token block at
implementation time; substitute the nearest defined token rather than inventing one.

## MODIFY eight `gui/src/i18n/*.ts`

| Key | English |
|---|---|
| `models.staleBanner` | Codex is showing an older model list than this catalog. Restart Codex to reload it. |

`dash.codexRestart`, `dash.codexRestarting`, `dash.codexRestartConfirm`, and the
failure strings all arrive in phase 2.

## Tests

`gui/tests/codex-stale-banner.test.tsx`:

| Scenario | Trigger | Observable proof |
|---|---|---|
| stale renders | `state="stale"` | banner text and button present |
| fresh renders nothing | `state="fresh"` | null output |
| not_running renders nothing | `state="not_running"` | null output |
| unknown renders nothing | `state="unknown"` | null output |
| null renders nothing | `state={null}` | null output |
| declined confirm | `confirm` stubbed false | zero fetch calls, `onRestarted` not called |
| success clears (stopped) | ok outcome, code `stopped` | `onRestarted` called once |
| **success clears (nothing_running)** | ok outcome, code `nothing_running` | `onRestarted` called once — the race regression this unit fixed |
| failure alerts | non-2xx | `onRestarted` not called, alert text shown |
| fetch helper: non-2xx | 500 | `state === null` |
| fetch helper: abort | aborted signal | `state === null`, no throw |

The four "renders nothing" cases are the activation evidence for invariant 3: a
regression that renders the banner on `unknown` would tell users their picker is
stale on every locked-down host.

## Accept criteria

1. Banner renders for `stale` and nothing else, proven by five separate renders.
2. The head action appears on every models sub-tab.
3. A declined confirm issues no request.
4. `onRestarted` re-reads the state so the banner clears without a page reload.
5. Unmount aborts the in-flight state fetch without an unhandled rejection.
6. `cd gui && bun run lint && bun test && bun run build` green.
7. Render grounding: screenshot the models page with the banner forced visible and
   read it back (C-RENDER-GROUNDING-01).

## Verifier commands

| Command | Reads this change? |
|---|---|
| `cd gui && bun test tests/codex-stale-banner.test.tsx` | yes — direct argument |
| `cd gui && bun test tests/models-workspace-panels.test.tsx` | yes — exercises `Models.tsx` |
| `cd gui && bun run build` | yes — parity and type errors surface here |

## Bypass record

- Tier: E2 (test-enforced).
- Executing surface: `bun test`.
- Known bypass: the banner depends on a reading that is `unknown` on a host where
  enumeration fails, so the user sees no banner even with a stale picker.
- Residual risk: accepted. The sidebar control is always available, so `unknown`
  costs discoverability, not capability.
- Wording downgrade: this is an early-warning surface, never a guarantee that a
  stale picker is detected. Final enforcement layer: none.

