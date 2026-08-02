# 030 — WP3: Codex Auth → Codex Set

The rename, the two-panel shell, and a **working** Prompt panel showing the five
toggle rows. WP4 then adds the other four layer classes and the dialog.

The first draft ended here with an empty placeholder and deferred the
loading-contract migration to WP4. An audit called that a forward dependency,
correctly: a phase that ships a panel saying "nothing here yet" cannot be
verified against anything.

## Route rename

Per `004` §A, edit in one commit:

| File | Change |
|---|---|
| `app-routing.ts:5-15` | `Page` union: `"codex-auth"` → `"codex-set"` |
| `app-routing.ts:20-30` | `VALID_PAGES` likewise |
| `app-routing.ts:85-93` | legacy table gains `codex-auth` → `codex-set` |
| `App.tsx:31-41` | `PAGE_TKEY`: `"codex-set": "nav.codexSet"` |
| `App.tsx:50-52` | `NAV` entry, position unchanged (second) |
| `App.tsx:307-316` | render `<CodexSet>` |
| `providers-page-utils.ts:19` | deep link → `#codex-set` |

The legacy redirect is not optional. `#codex-auth` is a bookmarkable URL that
has shipped, and `use-app-route-state.ts:44` reads the initial page straight
from the hash — without the entry, an old bookmark lands on a 404-ish unknown
page.

**`/api/codex-auth/*` does not move.** `004` §C: about a dozen test files bind
to that namespace and renaming it buys nothing.

## Files

```
gui/src/pages/CodexSet.tsx            (new — shell, ~120 lines)
gui/src/pages/codex-set-multiauth.tsx (new — today's CodexAuth body, moved)
gui/src/pages/codex-set-prompt.tsx    (new — toggle rows + data surface)
gui/src/pages/CodexAuth.tsx           (deleted)
```

## The Prompt panel in this phase

`useDataSurface("codex-prompt:" + apiBase, ...)` over `GET /api/codex-prompt`
(`004` §G). Renders only `class === "config-toggle"` rows — five switches, each
PUTting with the snapshot revision and republishing the echoed snapshot via
`setClientResourceData`.

`CodexSet` joins `MIGRATED` in `page-loading-contract.test.tsx:25-39` **in this
phase**, since it now has a real data surface.

Rows for the other classes are deliberately absent, not stubbed. A phase that
renders half a taxonomy invites a reader to assume the rest does not exist.

`codex-set-multiauth.tsx` is a **move, not a rewrite**. Everything
`CodexAuth.tsx:93-177` owns — the `/api/config` fetch, the session cache key,
the 30s poll, provider recovery, the banner — moves verbatim and keeps
delegating to `CodexAccountPool`. The session cache key
`ocx.codex-auth.config.v1:${apiBase}` stays as-is: renaming it would discard
every user's warm cache for no benefit.

## Shell

Modeled on `Logs.tsx:408-425` (`004` §B):

```tsx
const tab = subRoute === "prompt" ? "prompt" : "multiauth";
// hash: #codex-set | #codex-set/prompt
// Prompt lazy-mounts on first visit, stays mounted after (Logs.tsx:551)
```

Reuses `.page-tabs` / `.page-tab` from `styles.css:417-423`. No new CSS in this
phase.

Tab switching pushes history so back/forward work, matching
`use-app-route-state.ts:39-90`.

## i18n

New `codexSet.*` namespace. English first (`en.ts` is authoritative,
`TKey = keyof typeof en` at `en.ts:1662`), then the same keys in all five other
locales **in the same commit** — `Record<TKey, string>` makes a gap a typecheck
failure (`004` §D).

WP3 keys:

```
nav.codexSet              "Codex Set"     / "Codex 설정"
codexSet.tab.multiauth    "Multi-auth"    / "다중 인증"
codexSet.tab.prompt       "Prompt"        / "프롬프트"
codexSet.prompt.title     "Prompt layers" / "프롬프트 레이어"
codexSet.prompt.timing    → see below
```

`codexSet.prompt.timing` is fixed copy from `003` §3:

- en: "Applies to newly started sessions. Running sessions keep their current
  prompt settings."
- ko: "새 세션부터 적용됩니다. 실행 중인 세션은 현재 설정을 유지합니다."

Not "즉시 적용", not "재시작 필요" — neither is proven, and `003` §3 leaves the
frontend reload path UNKNOWN.

The 130 existing `codexAuth.*` keys are untouched.

## Tests

Update:

- `gui/tests/sidebar-codex-auth.test.ts:14-23` → rename file to
  `sidebar-codex-set.test.ts`, assert the new id and that the legacy id still
  resolves.
- `gui/tests/dashboard-tabs.test.ts:45-52` → `codex-set` second.

Add `gui/tests/codex-set-shell.test.tsx`:

1. `#codex-set` renders Multi-auth, not Prompt
2. `#codex-set/prompt` renders Prompt
3. `#codex-auth` **redirects** to `#codex-set` — the bookmark guarantee
4. Prompt does not mount until first visited
5. Prompt stays mounted after switching away
6. tab switch pushes history; back returns to the previous tab
7. the timing string renders and contains neither "즉시" nor "재시작"
8. the five toggle rows render from the inventory
9. toggling PUTs once, with the current revision
10. a stale-revision 409 re-reads instead of retrying blindly
11. `configExists: false` leaves switches **live**, not disabled

Case 7 pins `003` §3 into a test so a later copy edit cannot quietly promise
something the runtime does not do. Case 11 pins the audit's blocker-9 fix.

## Verification

`bun run typecheck` (catches any locale gap), `bun run test`,
`bun run lint:gui`.
