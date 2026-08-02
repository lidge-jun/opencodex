# 040 — Phase 4: GUI export panel

Consumes `030` (route) and implements `003` (design). Last phase; the only one a
non-CLI user ever sees.

## Scope

IN
- NEW `gui/src/components/apikeys-workspace/ClientConfigPanel.tsx`.
- MODIFY `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` — mount it.
- MODIFY `gui/src/styles-apikeys-workspace.css` — panel styles under the existing `awi-` namespace.
- MODIFY `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` — new `api.clientConfig.*` keys.
- NEW `tests/gui-client-config-panel.test.ts` (or the GUI suite's convention).

OUT
- No change to the catalog table or key rail.
- No client-side config generation — the panel renders what `030` returns.
- No file-write to the user's machine beyond a browser download.

## Component contract

```tsx
<ClientConfigPanel
  apiBase={string}
  hasKeys={boolean}     // drives the empty-state line (003 §4)
/>
```

State machine, one fetch per client selection:

| State | Trigger | Render |
|-------|---------|--------|
| loading | mount, client switch | `DataSurfaceSkeleton` — known structure, owns the single live-region announcement |
| ready | 200 | JSON block + actions + framing |
| degraded | 200 with `modelsWithoutLimits > 0` | ready, plus one muted line stating the count |
| empty-key | 200 with `hasKeys === false` | ready, plus one line: the referenced variable has no key yet, linking to Generate |
| error | 4xx/5xx/network | notice with retry; base URL stays visible |

`empty-key` never disables export (`003` §3) — an agent may want the shape first.

## Layout

Per `003` §6 the panel lives in the connect cluster. Internal composition, top to
bottom:

```
Client config                                    [Copy JSON]  [Download]
┌ segmented ───────────────┐
│ OpenCode │ Pi            │
└──────────────────────────┘
<pre> the JSON </pre>
Destination: ~/.config/opencode/opencode.json          (copyable)
export OPENCODEX_OPENCODE_API_KEY=<your key>           (copyable)
Merge into that file; do not replace it.
19 models · 2 omit context limits
› Where this file goes                                 (disclosure)
```

Copy is the primary action (`003` §3), so it carries `btn-primary` weight and
Download is a plain `btn`. The segmented control reuses the connect bar's protocol
selector styling — same component grammar, not a new one.

The JSON block reuses `api-code`/`api-example-pre` and inherits the existing
wheel-scroll rules in `styles-apikeys-workspace.css` (`overflow-y: visible`,
`overscroll-behavior: auto`) so a long config never traps page scroll.

## Download behavior

Mechanics copied from `gui/src/pages/ClaudeDesktop.tsx:313`:

```ts
const url = URL.createObjectURL(new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" }));
const anchor = document.createElement("a");
anchor.href = url;
anchor.download = filename;   // from the route envelope: opencode.json | pi-models.json
anchor.click();
URL.revokeObjectURL(url);
setAnnouncement(t("api.clientConfig.downloadedAnnounce", { filename, destination }));
```

Three design rules from `003` §5 are load-bearing here:

- `filename` comes from the server envelope, never hardcoded in the component.
- The announcement says **downloaded**, and names the destination it must be moved
  or merged into. It must not say "applied", "saved", or "configured".
- The trigger is a real `<button>`; the anchor is created and discarded internally.

## i18n

Every string goes through `useT()`; the repo's eslint rule forbids hardcoded UI
strings. New keys:

```
api.clientConfig.title            api.clientConfig.copy
api.clientConfig.clientOpencode   api.clientConfig.download
api.clientConfig.clientPi         api.clientConfig.destination
api.clientConfig.mergeWarning     api.clientConfig.envHint
api.clientConfig.modelCount       api.clientConfig.missingLimits
api.clientConfig.noKeyYet         api.clientConfig.loadFailed
api.clientConfig.retry            api.clientConfig.downloadedAnnounce
api.clientConfig.copiedAnnounce   api.clientConfig.whereDisclosure
```

The JSON payload itself is machine data and is never translated.

## Accessibility

- One live region per transition (house rule, `data-surface.tsx:4`): the skeleton
  owns loading; copy/download announcements fire only after the surface is ready.
- Segmented control is a real radio group or `aria-pressed` button group, keyboard
  reachable, no `tabindex`.
- The `<pre>` block is focusable for keyboard selection and labeled with the
  client name so a screen-reader user knows which config they are on.

## File change map

| Path | Action |
|------|--------|
| `gui/src/components/apikeys-workspace/ClientConfigPanel.tsx` | NEW |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY — mount in the connect cluster |
| `gui/src/styles-apikeys-workspace.css` | MODIFY — `awi-clientconfig-*` rules |
| `gui/src/i18n/*.ts` | MODIFY — 15 keys x 6 locales |
| GUI test | NEW |

## Accept criteria

1. Switching client refetches and swaps the rendered JSON. **Activation:** the test
   selects Pi and asserts the payload shape changed to an array-bearing config.
2. Download produces a Blob whose parsed content deep-equals the fetched `config`,
   with the server-provided filename. **Activation:** stub `createObjectURL`, capture
   the Blob, parse it.
3. Route failure renders the error notice with a working retry; no partial JSON.
4. `modelsWithoutLimits > 0` renders the degraded line; `=== 0` does not.
5. `hasKeys === false` renders the no-key line AND leaves both actions enabled.
6. No hardcoded UI string (eslint `local-i18n/no-hardcoded-ui-strings` clean).
7. Rendered check per C-RENDER-GROUNDING-01: load the panel in a headless browser
   at 1280x720, screenshot, read it back, confirm the JSON block does not trap
   wheel scroll and the action row does not wrap at the narrow breakpoint.
8. `bun run lint:gui` and `bun run build:gui` clean.
