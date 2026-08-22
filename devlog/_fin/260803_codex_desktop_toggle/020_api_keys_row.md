# WP4 — API keys out of the client-card grid

> "이 api 키는 박스로 두지말고 위쪽에 한 라인으로 빼자"
>
> "don't leave this API key as a box/card - pull it out to the top as a single line/row."

Independent of WP2/WP3. This is a layout and summary-semantics change; the
`/api/keys` read already returns the only fact this surface needs.

## IN / OUT

IN: `gui/src/pages/integrations/overview-clients.ts` (MODIFY),
`gui/src/pages/integrations/IntegrationsOverview.tsx` (MODIFY),
`gui/src/styles-integrations.css` (MODIFY),
`gui/src/i18n/en.ts` (MODIFY), `gui/src/i18n/ko.ts` (MODIFY),
`gui/src/i18n/ja.ts` (MODIFY), `gui/src/i18n/zh.ts` (MODIFY),
`gui/src/i18n/de.ts` (MODIFY), `gui/src/i18n/ru.ts` (MODIFY),
`gui/tests/integrations-overview-rows.test.ts` (MODIFY),
`gui/tests/overview-state-merge.test.ts` (MODIFY), and
`gui/tests/integrations-surfaces.test.tsx` (MODIFY),
`gui/tests/api-key-count-loader.test.ts` (NEW — the only new file; no
implementation file is NEW).

IN also: `gui/src/pages/integrations/integration-api.ts` (MODIFY) — see
§Distinguishing a failed read.

OUT: `gui/src/pages/integrations/IntegrationStateBadge.tsx` — **not reused at
all**, neither the component nor its `unknown/current/absent` vocabulary. Its
labels are “Applied”/“Not applied” (`:12`), which is the claim this phase
exists to stop making about a credential. `src/`, `tests/`, and `docs-site/` —
this neither changes the management contract nor setup behavior.

## Why keys is not a card

Every grid card represents a client that can be detected, applied, stale, or
unsafe against client-owned configuration. Most carry a switch and a config
path; the exceptions still describe routing or a profile that can drift.

API keys have neither property. They cannot be installed as a client, toggled,
or drift from a config file. Their entire overview state is the count returned
by `loadApiKeyCount`: zero keys, N issued keys, or an unsettled read, plus a way
to open the keys tab. Painting that credential inventory as one peer in the
client grid is the asymmetry that caused both the orphaned card and the false
summary totals. The type boundary should now say the same thing as the layout.

## Distinguishing a failed read from an in-flight one

`loadApiKeyCount` returns `null` for an in-flight read, a network failure, a
non-ok response, and a malformed body alike, because `readOptional` catches
everything (`integration-api.ts:259-265`). `useDataSurface` then sees a
SUCCESSFUL result carrying `null` (`data-surface.ts:127`), and there is no
polling on this surface.

So a “Checking…” string on that `null` would be permanent after a failure. The
audit is right that avoiding “No keys issued” is necessary but not sufficient:
indefinite progress copy is its own lie, and it is the more annoying one because
it never resolves.

A returned `null` cannot express failure, because the resource layer treats any
successful return as data. So the loader **throws**, and the read phase comes
from the resource state that already exists.

MODIFY `integration-api.ts`:

```diff
-export async function loadApiKeyCount(apiBase: string, signal?: AbortSignal): Promise<number | null> {
-  const body = await readOptional<{ keys?: unknown }>(fetch(`${apiBase}/api/keys`, { signal }));
-  if (!body || !Array.isArray(body.keys)) return null;
-  return body.keys.length;
-}
+/**
+ * Throws on a failed or malformed read rather than returning null.
+ *
+ * `readOptional` is right for surfaces that treat "no answer" and "empty" the
+ * same. This one cannot: the overview must say "Checking..." while a read is in
+ * flight and "Key status unavailable" once it has settled badly, and a
+ * successfully-returned null collapses both into `ready-empty`
+ * (data-surface.ts:128) with no polling to ever correct it. Throwing is what
+ * produces `failed-cold` / `failed-with-stale`, which is the signal the row
+ * needs. Aborts never reach a state: client-resource.ts:230-244 discards an
+ * aborted generation before publishing either data or failure.
+ */
+export async function loadApiKeyCount(apiBase: string, signal?: AbortSignal): Promise<number> {
+  const response = await fetch(`${apiBase}/api/keys`, { signal });
+  if (!response.ok) throw new Error(`/api/keys responded ${response.status}`);
+  const body = await readJsonIfOk<{ keys?: unknown }>(response);
+  if (!body || !Array.isArray(body.keys)) throw new Error("/api/keys returned an unexpected body");
+  return body.keys.length;
+}
```

`loadApiKeyCount` has exactly one production consumer, `IntegrationsOverview`;
the other API-key surfaces fetch `/api/keys` directly, so nothing else changes.

The component wiring for this lives in one place — §Render — so an implementer
never has to reconcile two partial diffs of the same object.

`overview-clients.ts` exports the phase type and `OverviewSources` carries it
(`:82-93`):

```diff
+/** How far the `/api/keys` read has got, since the count alone cannot say. */
+export type ApiKeyReadPhase = "checking" | "unavailable" | "settled";
+
 export interface OverviewSources {
   /** File-client rows; an empty array means the list has not settled. */
   clients: readonly IntegrationStatus[];
   clientsSettled: boolean;
   codex: CodexRoutingPayload | null;
   keyCount: number | null;
+  /**
+   * Read phase for `keyCount`. Separate because a settled zero and a failed
+   * read are both `null`-adjacent facts that must not render the same way.
+   */
+  keyPhase: ApiKeyReadPhase;
   claude: ClaudeCodePayload | null;
```

## Row model — `overview-clients.ts`

`OverviewClientId` stops admitting `keys`. `buildOverviewRows` still owns the
normalization of all overview sources, but its result separates the credential
row from client rows instead of returning one mixed array (`:24-59`, `:153-176`,
`:352-397`).

```diff
 export type OverviewClientId =
   | "codex"
-  | "keys"
   | "claude"
   | "claudeDesktop"
   | "grok"
   | FileIntegrationClientId;

+export interface ApiKeysOverviewRow {
+  hash: "integrations/keys";
+  labelKey: TKey;
+  /**
+   * Credential vocabulary, deliberately NOT the client `unknown|absent|current`
+   * triple. Those words carry "applied", which is the claim this row must never
+   * make. Keeping the client values here — even unrendered — would be an open
+   * invitation to reconnect IntegrationStateBadge and undo the whole phase.
+   */
+  state: "checking" | "unavailable" | "none-issued" | "issued";
+  detailKey: TKey | null;
+  detailVars: Record<string, string> | null;
+}
+
+export interface OverviewRows {
+  keysRow: ApiKeysOverviewRow;
+  rows: OverviewRow[];
+}

 /** API keys are issued or not; there is no config file to drift. */
-function keysRow(count: number | null): OverviewRow {
-  const base = {
-    id: "keys" as const,
-    hash: "integrations/keys",
-    labelKey: "integrations.tab.keys" as TKey,
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
-    status: null,
-    detail: null,
-  };
+function keysRow(phase: ApiKeyReadPhase, count: number | null): ApiKeysOverviewRow {
+  const base = {
+    hash: "integrations/keys" as const,
+    labelKey: "integrations.tab.keys" as TKey,
+  };
+  // Every branch names a detail key. The detail line is the ONLY state
+  // expression now that the badge is gone, so a null one renders a row with no
+  // state at all — which is how the first draft of this phase managed to
+  // declare a "Checking…" string and never show it.
+  if (phase === "checking") {
+    return { ...base, state: "checking", detailKey: "integrations.detail.keyChecking", detailVars: null };
+  }
+  if (phase === "unavailable" || count === null) {
+    return { ...base, state: "unavailable", detailKey: "integrations.detail.keyUnavailable", detailVars: null };
+  }
+  return {
+    ...base,
+    state: count > 0 ? "issued" : "none-issued",
+    detailKey: count > 0 ? "integrations.detail.keyCount" : "integrations.detail.keyNone",
+    detailVars: count > 0 ? { count: String(count) } : null,
   };
 }

-export function buildOverviewRows(sources: OverviewSources): OverviewRow[] {
+export function buildOverviewRows(sources: OverviewSources): OverviewRows {
   const nativeClaude = sources.native?.find(status => status.clientId === "claude");
   const nativeGrok = sources.native?.find(status => status.clientId === "grok");
   const statusByClient = new Map(sources.clients.map(status => [status.clientId, status]));
   const rows: OverviewRow[] = [
     codexRow(sources.codex),
-    keysRow(sources.keyCount),
     claudeRow(sources.claude, nativeClaude, sources.nativeSettled),
     claudeDesktopRow(sources.claudeDesktop),
     grokRow(sources.grok, nativeGrok, sources.nativeSettled),
   ];
   // Existing file-client loop stays byte-for-byte unchanged.
-  return rows;
+  return { keysRow: keysRow(sources.keyPhase, sources.keyCount), rows };
 }
```

Also change the file docstring's “Five more sources join the grid” to “Four
more client sources join the grid; API keys return separately,” change
`OverviewRow`'s “other five” detail comment to “other four,” and replace the
catalog-order comment at `:352-356` with the actual client order: Codex, Claude,
Claude Desktop, Grok, then the file clients. Comments must not keep claiming
that keys joins the grid after the type no longer permits it.

`ApiKeysOverviewRow` deliberately has no `installed`, `applied`, `toggle`, or
`status`. Re-adding one of those fields would recreate the semantic leak this
phase removes. `gui/tests/overview-state-merge.test.ts` changes only its helper
to search `buildOverviewRows(...).rows`; native-state behavior is otherwise
untouched.

## Render — `IntegrationsOverview.tsx`

The row goes immediately **below the summary strip** and above onboarding,
notices, and the grid (`:433-498`). The summary is the page-level aggregate;
the keys row is one credential surface with one action. Putting keys above the
summary would promote one surface over the aggregate, while merging it into the
strip would make “Manage keys” look like a bulk-status control beside “Disable
all.” Below preserves aggregate → individual → client catalog hierarchy.

```diff
 import {
   buildOverviewRows,
   countOverviewRows,
+  type ApiKeyReadPhase,
+  type ApiKeysOverviewRow,
   type OverviewRow,
 } from "./overview-clients";

+/**
+ * Credentials are one explicit action, not a clickable client card.
+ *
+ * Do not stretch the title over this row. The card overlay exists because a
+ * card also contains a switch; this row has no nested-control problem to
+ * solve. A plain Manage keys button is the one tab stop, so its visible label,
+ * focus ring, Enter, and Space behavior all come from a native button.
+ */
+function ApiKeysRow({ row }: { row: ApiKeysOverviewRow }) {
+  const t = useT();
+  const detail = row.detailKey ? t(row.detailKey, row.detailVars ?? undefined) : null;
+  return (
+    <div className="integration-api-keys-row" data-client="keys" data-key-state={row.state}>
+      <div className="integration-api-keys-copy">
+        <h4>{t(row.labelKey)}</h4>
+        {detail && <p className="integration-meta">{detail}</p>}
+      </div>
+      {/*
+        NOT IntegrationStateBadge. It renders `current` as "Applied" and
+        `absent` as "Not applied" in all six locales (LABEL_KEYS in
+        IntegrationStateBadge.tsx:12), which is exactly the claim this phase
+        argues is false — the live zero-key card says `미적용` today. The
+        detail line above already carries the honest state, so a badge here
+        could only re-say it wrongly.
+
+        `data-key-state` on the wrapper is how the four states stay testable
+        and stylable without a visible client-vocabulary badge. It is the one
+        consumer of `row.state`; without it the field would be dead weight and
+        the next author would reach for the badge again.
+      */}
+      <button
+        type="button"
+        className="btn btn-ghost"
+        onClick={() => navigateHash(row.hash)}
+      >
+        {t("integrations.action.manageKeys")}
+      </button>
+    </div>
+  );
+}

   const keysResource = useDataSurface(
     `integration-keys:${apiBase}`,
     [apiBase],
     fetchKeyCount,
-    { isEmpty: value => value === null, enabled: active },
+    // The loader now throws instead of resolving null, so null is no longer a
+    // value it can produce. Leaving the old predicate would classify nothing
+    // and quietly outlive the contract it was written for.
+    { isEmpty: () => false, enabled: active },
   );
...
+  /*
+   * The three phases the keys row distinguishes, read off the resource rather
+   * than guessed from a null — the same idiom as clientsSettled above. A
+   * failed read must never reach the count branch: `failed-with-stale` still
+   * carries the previous number, and rendering it as "N issued" would report a
+   * stale credential inventory as current.
+   */
+  const keyPhase: ApiKeyReadPhase =
+    keysResource.state.kind === "cold" || keysResource.state.kind === "retrying-cold"
+      ? "checking"
+      : keysResource.state.kind === "failed-cold" || keysResource.state.kind === "failed-with-stale"
+        ? "unavailable"
+        : "settled";
-  const rows = buildOverviewRows({
+  const { keysRow, rows } = buildOverviewRows({
     clients,
     clientsSettled,
     codex: codexResource.state.data ?? null,
     keyCount: keysResource.state.data ?? null,
+    keyPhase,
     claude: claudeResource.state.data ?? null,
     claudeDesktop: claudeDesktopResource.state.data ?? null,
     grok: grokResource.state.data ?? null,
     native,
     nativeSettled,
   });
   const counts = countOverviewRows(rows);

       </div>

+      <ApiKeysRow row={keysRow} />
+
       <p className="page-sub">{t("integrations.onboarding")}</p>

       {/*
-        The grid used to disappear entirely when no FILE client was installed,
-        which now means hiding Codex, API keys, Claude and Grok because the
+        The grid used to disappear entirely when no FILE client was installed,
+        which means hiding Codex, Claude and Grok because the
         user has not installed OpenCode. The "nothing detected" panel is about
         the file clients specifically, so it sits BELOW the grid and says so
         instead of replacing everything.
       */}
```

The row itself has no click handler and no `tabIndex`. Its heading, count, and
state text remain readable in document order; only the native action button enters
the tab sequence, once, at the same visual position. This does not copy the
card's `::after` overlay, does not add a second `tabIndex={-1}` action, and
cannot swallow a future control through stacking order.

## CSS — `styles-integrations.css`

Insert after the summary rules (`:11-14`), before `.integration-cards`. This is
a full-width divider row, not `.integration-card` with `grid-column: 1 / -1`:
it has no raised background, surrounding border, radius, or card hover state.

```diff
 .integration-summary-label { font-size: var(--text-caption); color: var(--muted); }
 .integration-summary .btn { margin-left: auto; }

+/* API keys are credential inventory, not a client card. A bottom rule keeps
+   the full-width row in the page flow without making it an orphaned wide card. */
+.integration-api-keys-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: 44px; padding: 0 0 14px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
+.integration-api-keys-copy { display: flex; align-items: baseline; flex: 1 1 220px; min-width: 0; flex-wrap: wrap; gap: 4px 10px; }
+.integration-api-keys-copy h4,
+.integration-api-keys-copy .integration-meta { margin: 0; }
+.integration-api-keys-row .btn { margin-inline-start: auto; flex: 0 0 auto; }
```

`flex-wrap` is intentional: at 320-390 px, long German/Russian action copy may
move below the state text instead of clipping. It remains one credential
row surface. At normal widths, `flex: 1 1 220px` keeps title/count together on
the left and the action on the right. The existing global `:focus-visible`
rule owns the button ring; the rendered keyboard check below proves it.

## Counts

Keys leave all four totals. `countOverviewRows(rows)` remains unchanged because
its input is now client rows only.

- `detected`: a keys API endpoint exists on every dashboard; that is not a
  detected client. Counting it makes the total increase even with zero keys.
- `applied`: issuing a credential is not applying opencodex to a client. Two
  keys are inventory, not two applied integrations — and the old code counted
  either number as exactly one anyway.
- `stale`: keys have no config file and cannot enter this state.
- `unknown`: a failed `/api/keys` read stays visible in the row's own state
  text, but must not inflate the number of client integrations whose state is
  unknown.

This changes current totals by at most one. That is not a regression hidden by
the layout move; it corrects what the labels already claim to measure. The
“Disable all” button remains file-client-only (`IntegrationsOverview.tsx:303-360`)
and is unaffected.

### The labels have to say what they now count

Audit finding #2: “at most one” is still a number the user watches change with
no explanation. On the live zero-key machine, **Detected goes 5 → 4** the moment
this ships, and Applied drops by one once a key exists. The current labels are
bare “Detected” and “Applied”, which never disclose that the scope is clients.

So the labels move with the scope. MODIFY all six locales:

| Key | en | ko |
|---|---|---|
| `integrations.summary.detected` | `Clients detected` | `감지된 클라이언트` |
| `integrations.summary.applied` | `Configured clients` | `설정된 클라이언트` |

ja `検出されたクライアント` / `設定済みクライアント`, zh `已检测客户端` /
`已配置客户端`, de `Clients erkannt` / `Konfigurierte Clients`, ru
`Клиентов найдено` / `Настроено клиентов`.

“Configured” rather than “applied” across the board, on the reviewer's reading
of each locale: `Clients applied` is awkward in English because configuration is
what gets applied, `適用中` reads as in-progress, `Clients aktiv` changes the
metric outright since a `stale` row still counts as applied while not being
active, and `Клиентов применено` is not a collocation. Configuration is the
thing all six can name accurately.

`integrations.summary.stale` and `lastChange` are unchanged: keys were never
counted in either.

Existing test `gui/tests/integrations-overview-rows.test.ts:128` pins the old
`applied` at 6 and must be updated to the new expected value, not deleted — a
pinned number that changes is the reason to pin it.

## i18n

The existing title/count keys stay unchanged. Add one action key to every
locale; hardcoding “Manage keys” in JSX is forbidden by `gui/AGENTS.md`.

| Key | File | Value |
|---|---|---|
| `integrations.action.manageKeys` | `gui/src/i18n/en.ts` | `Manage keys` |
| `integrations.action.manageKeys` | `gui/src/i18n/ko.ts` | `키 관리` |
| `integrations.action.manageKeys` | `gui/src/i18n/ja.ts` | `キーを管理` |
| `integrations.action.manageKeys` | `gui/src/i18n/zh.ts` | `管理密钥` |
| `integrations.action.manageKeys` | `gui/src/i18n/de.ts` | `Schlüssel verwalten` |
| `integrations.action.manageKeys` | `gui/src/i18n/ru.ts` | `Управлять ключами` |

Reused in all six locales: `integrations.tab.keys`,
`integrations.detail.keyCount`, and `integrations.detail.keyNone`.

**No state-badge label is reused.** The row does not render
`IntegrationStateBadge`, because its `current`/`absent` labels are “Applied” and
“Not applied” (`IntegrationStateBadge.tsx:12`) — the exact wording this phase
argues is wrong for a credential. The detail line IS the state.

That leaves the two non-count states needing their own words, since neither can
borrow the badge “Unknown”. Add two keys to every locale:

| Key | en | ko |
|---|---|---|
| `integrations.detail.keyChecking` | `Checking…` | `확인 중…` |
| `integrations.detail.keyUnavailable` | `Key status unavailable` | `키 상태를 확인할 수 없음` |

ja `確認中…` / `キーの状態を取得できません`, zh `检查中…` / `无法获取密钥状态`,
de `Wird geprüft…` / `Schlüsselstatus nicht verfügbar`, ru `Проверка…` /
`Статус ключей недоступен`.

Two strings rather than one because they are two different facts, per
§Distinguishing a failed read. Neither may render as “No keys issued”: that is a
claim about the account of the user that a failed read cannot support.

## Test plan

MODIFY `gui/tests/integrations-overview-rows.test.ts`:

1. Destructure `{ keysRow, rows }` and assert all FOUR credential states:
   `("checking", null)` → `checking` + `keyChecking`;
   `("unavailable", null)` → `unavailable` + `keyUnavailable`;
   `("settled", 0)` → `none-issued` + `keyNone`;
   `("settled", 2)` → `issued` + `keyCount` with `{ count: "2" }`.
   A `("settled", null)` fixture must also yield `unavailable`, never
   `none-issued` — that is the branch that would otherwise tell a user they
   have no keys because a read failed.
2. Client `unknown` count is 4, not 5, in every one of those cases. With Codex,
   Claude, Desktop, Grok, and one file client applied, walking the key phase
   through all four leaves `applied === 5` unchanged.
3. Update settled lengths from 5 to 4 and unsettled lengths from 11 to 10;
   assert no member of `rows` has id `keys`.
4. Keep every existing Codex/Desktop/file-client mapping case against `rows`.
5. Update the pinned `applied` at `:128` to its new value and leave it pinned.

NEW `gui/tests/api-key-count-loader.test.ts`, because the loader's contract
changed from "returns null on anything bad" to "throws on anything bad", and a
mounted "failure" case only exercises one of the five ways it can now throw:

1. a valid `{ keys: [] }` resolves `0` — zero is data, not a failure;
2. a valid `{ keys: [a, b] }` resolves `2`;
3. a non-ok status rejects;
4. a malformed or empty body rejects;
5. `{ keys: "not-an-array" }` rejects;
6. a network rejection propagates rather than being swallowed.

Case 5 is the one the old `readOptional` path silently turned into "no keys
issued", which is the exact false claim this phase exists to stop. Abort
behavior is not retested here — `client-resource` already owns it.

MODIFY `gui/tests/overview-state-merge.test.ts`: its `row()` helper reads the
`.rows` member. No assertion changes.

**Both fixture builders need the new required field.** `keyPhase` is not
optional on `OverviewSources`, and the `sources()` helpers in
`overview-state-merge.test.ts:17` and `integrations-overview-rows.test.ts:28`
both construct one today without it — so neither file compiles until each
defaults `keyPhase: "settled"`, with per-case overrides in the four-state
matrix above. Naming this explicitly because "no assertion changes" reads like
"no edits needed", and it is not.

MODIFY `gui/tests/integrations-surfaces.test.tsx` with a mounted overview case.

**First, the fixture needs work the audit found missing.** `failExtraSources`
fails Codex, keys, Claude, Desktop and Grok together
(`integrations-surfaces.test.tsx:56`), so it cannot show that an API-key failure
ALONE leaves the client totals alone — the assertion would pass or fail for
unrelated unknown rows. The mock also has no `/api/native-integrations`
response, leaving native state permanently unsettled in mounted tests, which
makes every count assertion mushy.

So add an independent `keyResponse` / `failKeys` control and a settled native
response, then hold every other source constant while driving `/api/keys`
through its three outcomes.

1. `[data-client="keys"]` exists, but
   `.integration-cards [data-client="keys"]` is null.
2. DOM order is `.integration-summary` → keys row → `.integration-cards`.
3. Drive `/api/keys` through a DEFERRED response (still in flight, asserting
   the "Checking…" copy before it settles), then `[]`, two keys, and a failure,
   with everything else settled and constant. Assert the row copy each time AND assert the client
   summary totals are **exact and identical** across all four. A relative
   "text is present" check would not catch the leak this phase exists to close.
4. **Tabbability, not button-counting.** Query every tabbable descendant of the
   row and assert the single result is the Manage keys button. "Exactly one
   button with tabIndex 0" still passes if the row later gains `tabIndex={0}`,
   an anchor, or another naturally focusable control — which is precisely the
   regression the assertion is supposed to prevent.
5. Assert the control is a native `<button type="button">` — that is what earns
   Enter/Space behavior from the platform — and that clicking it navigates to
   `#integrations/keys`.

   **Enter/Space activation is NOT asserted here.** The reviewer probed this
   repository's `happy-dom@20.11.1` and native default activation is not
   modeled: dispatching keydown/keyup on a focused button produces zero click
   events. A test written as specified would either fail for a reason unrelated
   to our code, or be "fixed" by calling `.click()`, which proves nothing about
   the keyboard. Keyboard activation is verified in the real browser at step 5
   of Verification instead, where the platform is the platform.

## Verification

1. `cd gui && bun test tests/api-key-count-loader.test.ts tests/integrations-overview-rows.test.ts tests/overview-state-merge.test.ts tests/integrations-surfaces.test.tsx`
2. `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`
3. `bun run typecheck`, `bun run test`, `bun run privacy:scan`
4. Start the real dashboard and open `http://localhost:10100/#integrations` at
   1280 px and 390 px. Inspect the screenshot and live DOM: one keys row below
   the summary, no keys descendant inside `.integration-cards`, no wide-card
   chrome, and the grid begins with Codex. At 390 px, switch through all six
   locales and confirm the action text wraps when needed rather than clipping.
5. Keyboard-tab to “Manage keys”; observe a visible focus ring, activate with
   Enter and Space, and confirm `#integrations/keys` opens. This step is where
   keyboard activation is actually proven, since happy-dom does not model it.
   Repeat with zero keys and with a failed keys read to observe the
   `none-issued` and `unavailable` states.
6. Confirm the summary reads “Clients detected / Configured clients” in the
   active locale and that its numbers no longer move when a key is issued or
   revoked.

Step 4 is **C-RENDER-GROUNDING-01**. The change is not verified by typecheck,
DOM assertions, or a produced-but-unread screenshot: it must be OBSERVED
rendered at `localhost:10100`, and any layout defect must be fixed and observed
again.

## Accept criteria

- C8 — API keys render as one full-width row above `.integration-cards`, below
  the aggregate summary, observed rendered at `localhost:10100`.
- The keys row is absent from the card grid and from all client summary totals;
  its own state — checking, unavailable, none-issued, or issued — remains
  visible, and a failed read never renders as "no keys".
- One native button is the complete keyboard path to the keys tab; no stretched
  card overlay or duplicate tab stop is introduced.
- C9's GUI tests, lint, i18n lint, build, repository typecheck/test, and privacy
  scan pass before WP4 is called done.
