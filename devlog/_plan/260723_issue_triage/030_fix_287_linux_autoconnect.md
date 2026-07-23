# 030 — Fix #287: Linux Auto-connect GUI honesty (option b)

Date: 2026-07-23 KST

Issue: https://github.com/lidge-jun/opencodex/issues/287

Implementation branch: `codex/fix-287-linux-autoconnect` from `origin/dev`

Work class: C2 API-to-GUI contract slice

## Scope contract

Implement option (b) only: the proxy host reports whether Auto-connect is
supported, and the Claude settings page renders the stored `systemEnv` value as
active only when that server capability is true.

Acceptance criteria:

1. `GET /api/claude-code` includes `autoConnectSupported: boolean`, derived from
   the proxy host (`process.platform === "darwin"`), never from the browser.
2. Darwin preserves the current enabled/disabled Auto-connect behavior.
3. Every non-Darwin host renders Auto-connect unchecked and disabled, even when
   `claudeCode.systemEnv: true` is persisted.
4. The disabled control has a localized, programmatically-associated explanation:
   Auto-connect is macOS-only and the supported workaround is `ocx claude`.
5. Saving the page after loading an unsupported persisted `true` submits
   `systemEnv: false`; the UI cannot report the unsupported value as active or
   successfully selectable.
6. No environment injection, shell hook, dotfile, `launchctl`, systemd, or config
   schema behavior is added.

Current implementation anchors, re-read at `ce863a65e1a06875c3bf8266e698941fea3b9d77`:

- Darwin-only runtime guards: `src/server/system-env.ts:75`, `:92`, `:210`, `:323`.
- Claude GET contract: `src/server/management-api.ts:1206-1263`; stored
  `systemEnv` is returned at `:1243` without a capability field.
- GUI state/load: `gui/src/pages/ClaudeCode.tsx:9-26`, `:51-55`.
- Generic toggle and Auto-connect row: `gui/src/pages/ClaudeCode.tsx:34-41`,
  `:165-172`.
- Toggle CSS: `gui/src/styles.css:1006-1012`.
- Locale source of truth and compile-checked dictionaries:
  `gui/src/i18n/en.ts:1-3`, `gui/src/i18n/shared.ts:2-12`.

## Dependency-ordered file change map

| Order | Change | Path | Exact responsibility |
|---:|---|---|---|
| 1 | MODIFY | `src/server/management-api.ts` | Add the server-derived `autoConnectSupported` boolean to `GET /api/claude-code`; do not alter PUT or persisted config shape. |
| 2 | MODIFY | `gui/src/i18n/en.ts` | Add the canonical `claude.systemEnvUnsupported` key with `{cmd}` placeholder. |
| 3 | MODIFY | `gui/src/i18n/ko.ts` | Add the Korean translation for the same key. |
| 4 | MODIFY | `gui/src/i18n/de.ts` | Add the German translation for the same key. |
| 5 | MODIFY | `gui/src/i18n/ja.ts` | Add the Japanese translation for the same key. |
| 6 | MODIFY | `gui/src/i18n/ru.ts` | Add the Russian translation for the same key. |
| 7 | MODIFY | `gui/src/i18n/zh.ts` | Add the Simplified Chinese translation for the same key. |
| 8 | MODIFY | `gui/src/styles.css` | Give the disabled label-toggle a visibly disabled cursor/opacity state. |
| 9 | MODIFY | `gui/src/pages/ClaudeCode.tsx` | Consume the capability, reconcile unsupported stored state on load, add disabled/description support to `SettingToggle`, and render the honest Auto-connect row. |
| 10 | MODIFY | `tests/claude-management-api.test.ts` | Lock the GET capability contract for mocked Darwin and Linux platforms. |
| 11 | NEW | `gui/tests/claude-code-autoconnect.test.tsx` | Add pure load-reconciliation and React SSR render coverage for supported and unsupported states from the GUI package, where React dependencies resolve. |

Implementation change-file count: **11**. No other production, test, locale,
documentation, package, lockfile, or workflow file changes belong in this PR.

## 1. Server capability contract

### `src/server/management-api.ts` — MODIFY

Keep `systemEnv` as the stored preference for backward compatibility. Add a
separate effective-capability field next to it.

Before (`GET /api/claude-code`, current `:1241-1244`):

```ts
tierModels: config.claudeCode?.tierModels ?? {},
modelMap: config.claudeCode?.modelMap ?? {},
systemEnv: config.claudeCode?.systemEnv === true,
maxContextTokens: config.claudeCode?.maxContextTokens ?? null,
```

After:

```ts
tierModels: config.claudeCode?.tierModels ?? {},
modelMap: config.claudeCode?.modelMap ?? {},
systemEnv: config.claudeCode?.systemEnv === true,
autoConnectSupported: process.platform === "darwin",
maxContextTokens: config.claudeCode?.maxContextTokens ?? null,
```

Contract invariants:

- Darwin: `autoConnectSupported === true` regardless of stored `systemEnv`.
- Linux and Windows: `autoConnectSupported === false` regardless of stored
  `systemEnv`.
- `systemEnv` remains the raw stored preference in the API response; the GUI owns
  effective display-state reconciliation.
- Do not add `autoConnectSupported` to `OcxClaudeCodeConfig`, PUT validation, or
  the config file. It is runtime capability metadata, not user configuration.

## 2. i18n additions

The English dictionary defines `TKey`; `de`, `ko`, `zh`, `ru`, and `ja` are
`Record<TKey, string>` dictionaries. Add exactly one key to every locale,
immediately after `claude.systemEnvDesc`. Use `<Trans>` so `{cmd}` renders as a
code chip rather than embedding JSX or a hard-coded command in the component.

```ts
// gui/src/i18n/en.ts
"claude.systemEnvUnsupported": "Auto-connect is available on macOS only. On this system, start Claude with {cmd}.",

// gui/src/i18n/ko.ts
"claude.systemEnvUnsupported": "자동 연결은 macOS에서만 지원됩니다. 이 시스템에서는 {cmd}로 Claude를 실행하세요.",

// gui/src/i18n/de.ts
"claude.systemEnvUnsupported": "Auto-Verbindung ist nur unter macOS verfügbar. Starten Sie Claude auf diesem System mit {cmd}.",

// gui/src/i18n/ja.ts
"claude.systemEnvUnsupported": "自動接続は macOS でのみ利用できます。このシステムでは {cmd} で Claude を起動してください。",

// gui/src/i18n/ru.ts
"claude.systemEnvUnsupported": "Автоподключение доступно только в macOS. В этой системе запускайте Claude с помощью {cmd}.",

// gui/src/i18n/zh.ts
"claude.systemEnvUnsupported": "自动连接仅在 macOS 上可用。在此系统上，请使用 {cmd} 启动 Claude。",
```

Do not modify `gui/src/i18n/shared.ts`, `provider.tsx`, or
`scripts/sync-locale-keys.mjs`; their existing typed dictionary and `{cmd}`
contracts already cover this addition.

## 3. GUI state and render contract

### `gui/src/pages/ClaudeCode.tsx` — MODIFY

#### 3.1 State shape and load reconciliation

Before (`ClaudeCodeState` and `load`):

```tsx
interface ClaudeCodeState {
  enabled: boolean;
  authMode: "subscription" | "proxy";
  systemEnv: boolean;
  fastMode: boolean | null;
  // ...
}

const r = await fetch(`${apiBase}/api/claude-code`).then(res => res.json());
setState({ ...r, authMode: r.authMode === "proxy" ? "proxy" : "subscription", systemEnv: r.systemEnv !== false, fastMode: r.fastMode ?? null, maxContextTokens: r.maxContextTokens ?? null, autoContext: r.autoContext !== false, autoCompactWindow: r.autoCompactWindow ?? null, injectAgents: r.injectAgents !== false, effectiveModelEnv: r.effectiveModelEnv ?? {} });
```

After:

```tsx
interface ClaudeCodeState {
  enabled: boolean;
  authMode: "subscription" | "proxy";
  autoConnectSupported: boolean;
  systemEnv: boolean;
  fastMode: boolean | null;
  // ...
}

export function reconcileAutoConnectState(response: {
  autoConnectSupported?: unknown;
  systemEnv?: unknown;
}): Pick<ClaudeCodeState, "autoConnectSupported" | "systemEnv"> {
  const autoConnectSupported = response.autoConnectSupported === true;
  return {
    autoConnectSupported,
    systemEnv: autoConnectSupported && response.systemEnv === true,
  };
}

const r = await fetch(`${apiBase}/api/claude-code`).then(res => res.json());
setState({
  ...r,
  authMode: r.authMode === "proxy" ? "proxy" : "subscription",
  ...reconcileAutoConnectState(r),
  fastMode: r.fastMode ?? null,
  maxContextTokens: r.maxContextTokens ?? null,
  autoContext: r.autoContext !== false,
  autoCompactWindow: r.autoCompactWindow ?? null,
  injectAgents: r.injectAgents !== false,
  effectiveModelEnv: r.effectiveModelEnv ?? {},
});
```

The strict `=== true` check is intentional: a missing capability from an old or
stale backend fails closed instead of recreating the misleading active state.
The helper is the single normalization boundary used by production and the
focused regression test.

#### 3.2 Disabled toggle primitive

Before:

```tsx
function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} aria-label={label} />
      <span className="slider" aria-hidden="true" />
    </label>
  );
}
```

After:

```tsx
function SettingToggle({
  label,
  checked,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="slider" aria-hidden="true" />
    </label>
  );
}
```

Existing toggle call sites need no edits because both new props default to the
current enabled behavior.

#### 3.3 Auto-connect row

Extract the row into an exported production component in the same file so its
rendered accessibility contract is directly testable without adding a browser
test dependency.

```tsx
export function AutoConnectSetting({
  supported,
  checked,
  onChange,
}: {
  supported: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useT();
  const unsupportedDescriptionId = supported ? undefined : "claude-system-env-unsupported";

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span className="title">{t("claude.systemEnv")}</span>
        {supported ? (
          <span className="desc">{t("claude.systemEnvDesc")}</span>
        ) : (
          <span className="desc" id={unsupportedDescriptionId}>
            <Trans k="claude.systemEnvUnsupported" cmd="ocx claude" />
          </span>
        )}
        {supported && checked && (
          <span className="desc" style={{ color: "var(--red)" }}>
            {t("claude.systemEnvWarn")}
          </span>
        )}
      </div>
      <SettingToggle
        label={t("claude.systemEnv")}
        checked={supported && checked}
        disabled={!supported}
        describedBy={unsupportedDescriptionId}
        onChange={onChange}
      />
    </div>
  );
}
```

Replace the current inline row at `gui/src/pages/ClaudeCode.tsx:165-172` with:

```tsx
<AutoConnectSetting
  supported={state.autoConnectSupported}
  checked={state.systemEnv}
  onChange={systemEnv => setState({ ...state, systemEnv })}
/>
```

The `save` body remains unchanged: it sends normalized `state.systemEnv`. Thus a
legacy Linux response `{ autoConnectSupported: false, systemEnv: true }` becomes
`state.systemEnv === false`, cannot be toggled on, and is persisted as false on
the next Save.

### `gui/src/styles.css` — MODIFY

Append this rule immediately after the existing focus-visible rule at current
`:1012`:

```css
.toggle input:disabled + .slider { opacity: 0.5; cursor: not-allowed; }
```

Do not change enabled toggle colors, geometry, or motion.

## 4. Tests

### `tests/claude-management-api.test.ts` — MODIFY

Insertion anchor: append at end of file, immediately after the closing of the
last test `PUT validation rejects bad shapes`
(`tests/claude-management-api.test.ts:382`, file currently ends with that
test's `});`). No import changes: the file already imports `saveConfig`,
`loadConfig`, `startServer`, and `OcxConfig`.

Platform override helper, matching `tests/system-env.test.ts:29-31`:

```ts
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}
```

The existing `afterEach` (`tests/claude-management-api.test.ts:35-42`) restores
env vars; add one line at its top so a failed assertion cannot leak platform
state:

```ts
// before (first line of afterEach body):
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;

// after:
const originalPlatform = process.platform;
afterEach(() => {
  setPlatform(originalPlatform);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
```

New tests (appended verbatim):

```ts
test("GET /api/claude-code reports Auto-connect support on Darwin", async () => {
  setPlatform("darwin");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.autoConnectSupported).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect unsupported outside Darwin", async () => {
  saveConfig({
    ...loadConfig(),
    claudeCode: { systemEnv: true },
  } as OcxConfig);
  setPlatform("linux");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.systemEnv).toBe(true);              // raw stored preference
    expect(d.autoConnectSupported).toBe(false);  // effective capability
  } finally {
    server.stop(true);
  }
});
```

Do not call PUT in these tests and do not invoke any system environment function;
the changed contract is GET serialization only.

### `gui/tests/claude-code-autoconnect.test.tsx` — NEW

Use the already-installed `react`, `react-dom/server`, Bun test runner, and
`LanguageProvider`; add no package or DOM-emulator dependency. Keep this test
outside `gui/src` so `tsc -b` does not include Bun test globals in the browser
application project. Run it from `gui/`, whose package owns the React
dependencies.

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import {
  AutoConnectSetting,
  reconcileAutoConnectState,
} from "../src/pages/ClaudeCode";

function renderAutoConnect(supported: boolean, checked: boolean): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <AutoConnectSetting supported={supported} checked={checked} onChange={() => {}} />
    </LanguageProvider>,
  );
}

test("Auto-connect reconciliation preserves a supported stored true", () => {
  expect(reconcileAutoConnectState({ autoConnectSupported: true, systemEnv: true })).toEqual({
    autoConnectSupported: true,
    systemEnv: true,
  });
});

test("Auto-connect reconciliation forces an unsupported stored true off", () => {
  expect(reconcileAutoConnectState({ autoConnectSupported: false, systemEnv: true })).toEqual({
    autoConnectSupported: false,
    systemEnv: false,
  });
});

test("Auto-connect reconciliation fails closed when the capability field is missing", () => {
  // stale backend (pre-capability-field proxy): absent autoConnectSupported must
  // deactivate a persisted systemEnv:true instead of presenting it as active
  expect(reconcileAutoConnectState({ systemEnv: true })).toEqual({
    autoConnectSupported: false,
    systemEnv: false,
  });
});

test("Auto-connect renders enabled and checked on a supported host", () => {
  const html = renderAutoConnect(true, true);
  expect(html).toContain('checked=""');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("macOS only");
});

test("Auto-connect renders disabled, unchecked, and explained on an unsupported host", () => {
  const html = renderAutoConnect(false, false);
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('checked=""');
  expect(html).toContain('aria-describedby="claude-system-env-unsupported"');
  expect(html).toContain("macOS only");
  expect(html).toContain('<code class="chip">ocx claude</code>');
});
```

Total new regression tests: **7** (2 API + 3 reconciliation + 2 rendered GUI).

### Verification commands

Run in this order from the repository root:

```bash
bun test --isolate tests/claude-management-api.test.ts tests/system-env.test.ts
(cd gui && bun test tests/claude-code-autoconnect.test.tsx)
bun run typecheck
bun run lint:gui
cd gui && bun run build && cd ..
bun run privacy:scan
bun run test
```

For rendered smoke after the automated gates, open `/#claude` against the built
proxy UI on the available host and verify the matching row in the activation
matrix below. The opposite platform path is covered deterministically by the API
platform tests and React SSR render tests; no Playwright dependency is added.

## 5. Activation matrix

| Proxy host | Stored `systemEnv` | API capability | GUI state after load | User-visible path | Save payload |
|---|---:|---:|---|---|---:|
| Darwin | `false`/absent | `true` | enabled, unchecked | Existing description; user may enable | current selection |
| Darwin | `true` | `true` | enabled, checked | Existing terminal-relaunch warning | `true` |
| Linux | `false`/absent | `false` | disabled, unchecked | macOS-only explanation + `ocx claude` | `false` |
| Linux | `true` (legacy persisted state) | `false` | reconciled to disabled, unchecked | macOS-only explanation + `ocx claude`; never shown active | `false` |
| Windows/other non-Darwin | either | `false` | disabled, unchecked | same supported workaround | `false` |
| Missing capability field (stale/old backend) | either | treated as `false` | disabled, unchecked | fail-closed explanation | `false` |

## Out of scope and follow-up

- Actual Linux environment injection is a separately tracked follow-up for
  resolution (a): Bash login/non-login and zsh hooks, `OPENCODEX_HOME`, user-wins
  ownership, safe uninstall/revert, SSH/systemd behavior, secret lifecycle, and
  Linux/Windows/macOS CI coverage.
- No Linux shell files, systemd user environment, `/etc/environment`, WSL path,
  Windows environment integration, or generic platform backend is implemented in
  this PR.
- No docs-site change is required: `docs-site/src/content/docs/guides/claude-code.md:31-43`
  already states that system environment integration is macOS-only and recommends
  `ocx claude` elsewhere.
- Open questions: **none**.
