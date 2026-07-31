# 040 — WP4: Grok switch UI in the shared vertical idiom, plus closing gates

Depends on WP3 (the routes and config field) and WP1 (the collapse store this reuses).
Audit fold-backs (blockers 3, 4, 7) come from `001_audit_synthesis.md`.

## Scope

IN: the Grok page becoming a switchable, vertical, collapsible surface; save + re-apply
flow; the locale keys for it; the full closing gate run and render observation.
OUT: any new TOML writer (forbidden — see `030`), Grok auth/credential work.

## Current shape

`gui/src/pages/Grok.tsx:88-113` renders `status.models` as a read-only `<table>` with
Model / Grok alias / Context columns. `gui/tests/grok-page.test.ts:12-19` asserts the
page issues no POST/PUT/DELETE/PATCH at all.

## Structure

Grok has no families, so the vertical container here is a single collapsible group per
**source**: native models and routed models. That keeps the same two-level disclosure
shape as Desktop without inventing a category that does not exist in the data.

```
Endpoint  http://127.0.0.1:10100/v1                    [Save] [Save & apply]
  ⚠ 3 models excluded — apply to update your Grok config
Native (4)                                                             ▾
  [on]  gpt-5.6-sol         ocx-gpt-5-6-sol        372k
  [off] gpt-5.4-mini        —                      —
Routed (19)                                                            ▸
```

A routed model that is switched off has no alias, because it is not in the fence — the
alias column shows `—` for it. That is honest and matches `readGrokStatus`, which can
only report what was written. The page NEVER computes an alias itself: alias allocation
lives in `buildGrokManagedBlock` with collision counters and user-table reservations
(`src/grok/inject.ts:130-165`), so a client-side guess would eventually be wrong
(audit blocker 3). Aliases come from `status.models`, matched by id.

## MODIFY — `gui/src/pages/Grok.tsx`

### 1. Types and state

```ts
interface GrokCandidate { id: string; contextWindow?: number; native: boolean }

interface GrokStatus {
  configPath: string;
  present: boolean;
  baseUrl: string | null;
  models: GrokStatusModel[];
  candidates: GrokCandidate[];   // NEW — the full visible catalog
  excluded: string[];            // NEW — the user's switches
}
```

```ts
// Same store WP1 introduces — one implementation, one fallback path, one test file
// (audit blocker 4). The key is Grok-specific so the two surfaces cannot collide.
const GROUP_COLLAPSE = makeCollapseStore("ocx.grok.collapsedGroups.v1");

const [excluded, setExcluded] = useState<Set<string>>(new Set());
const [savedExcluded, setSavedExcluded] = useState<Set<string>>(new Set());
// null = no stored preference; both groups start open because Grok has only two.
const [collapsed, setCollapsed] = useState<Set<string>>(() => GROUP_COLLAPSE.read() ?? new Set());
const [pending, setPending] = useState<"save" | "apply" | null>(null);
const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
const [announcement, setAnnouncement] = useState("");
```

The toggle writes through the store, mirroring WP1:

```ts
const toggleGroup = (id: string) => {
  const next = toggleInSet(collapsed, id);
  GROUP_COLLAPSE.write(next);
  setCollapsed(next);
};
```

`dirty` is a set comparison, mirroring the Desktop page's `dirty` memo:

```ts
const dirty = useMemo(
  () => excluded.size !== savedExcluded.size || [...excluded].some(id => !savedExcluded.has(id)),
  [excluded, savedExcluded],
);
```

### 2. Save + apply

```ts
const save = async (applyAfter: boolean) => {
  if (pending) return;
  setPending("save");
  setMessage(null);
  try {
    const response = await fetch(`${apiBase}/api/grok/selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded: [...excluded] }),
    });
    if (!response.ok) throw new Error(await errorText(response, t("grok.saveFailed")));
    setSavedExcluded(new Set(excluded));
    if (applyAfter) {
      setPending("apply");
      const applied = await fetch(`${apiBase}/api/grok/apply`, { method: "POST" });
      const payload = await applied.json().catch(() => ({})) as { message?: string; skippedReason?: string };
      if (!applied.ok) throw new Error(payload.message ?? t("grok.applyFailed"));
      // A policy skip is not success theatre: name it, because the user's Grok config
      // did NOT change (non-loopback bind, or no ~/.grok at all).
      if (payload.skippedReason) setMessage({ tone: "err", text: payload.message ?? t("grok.applySkipped") });
      else setMessage({ tone: "ok", text: t("grok.savedApplied") });
      await load();
    } else {
      setMessage({ tone: "ok", text: t("grok.saved") });
    }
    setAnnouncement(...);
  } catch (err) { setMessage({ tone: "err", text: ... }); }
  finally { setPending(null); }
};
```

### 3. Groups

```tsx
const GROUPS = [
  { id: "native", tkey: "grok.groupNative" as TKey },
  { id: "routed", tkey: "grok.groupRouted" as TKey },
] as const;
```

Each group renders with the shared collapsible-group chrome WP1 already introduced —
`.ocx-group-stack`, `.ocx-group`, `.ocx-group-head`, `.ocx-group-toggle`,
`.ocx-group-heading`, `.ocx-group-name`, `.ocx-group-count`, `.ocx-chevron`
(`010` § Class vocabulary decision). WP4 **consumes** them and renames nothing: the
vocabulary split was settled in WP1 so this phase adds no CSS beyond Grok's own row
(`.grok-model-row`) and reuses the existing `.grok-endpoint` block.

Row: `<Switch>` from `gui/src/ui.tsx:8` + label + alias `<code>` + context. `Switch`
accepts only `on`/`onClick`/`disabled`/`label`, and its fallback label is English, so
every row passes a translated `label` (`t("grok.toggleModel", { id })`). A switch flip
only mutates `excluded`; nothing is written until Save.

### 4. Empty / absent states preserved

`grok.notConfiguredTitle` / `grok.notConfiguredHint` (`Grok.tsx:79-86`) stay: absent is
a state, not an error. When absent, switches still render — the user can pick models
before Grok exists — but `Save & apply` explains it will be a no-op via the skip
message rather than pretending it worked.

## MODIFY — `gui/tests/grok-page.test.ts`

The "no write requests" test is now wrong in letter and right in spirit. Replace it with
the narrower rule it was protecting:

```ts
// The page may write its own SELECTION and ask the proxy to re-run the guarded sync,
// but it must never gain a path that writes ~/.grok/config.toml directly. injectGrokConfig
// owns that file (backup, byte-for-byte preservation, non-loopback refusal).
test("the Grok page only writes selection state and triggers the guarded sync", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("/api/grok/selection");
  expect(page).toContain("/api/grok/apply");
  expect(page).not.toContain("config.toml");
});
```

## Locale keys — NEW (all six locales)

| Key | en |
|-----|----|
| `grok.groupNative` | `Native models` |
| `grok.groupRouted` | `Routed models` |
| `grok.modelCountOne` / `grok.modelCountMany` | `{count} model` / `{count} models` |
| `grok.enabledCount` | `{on} of {total} registered` |
| `grok.saved` | `Selection saved.` |
| `grok.savedApplied` | `Selection saved and written to your Grok config.` |
| `grok.saveFailed` | `Could not save the Grok selection.` |
| `grok.applyFailed` | `Selection saved, but the Grok config could not be updated.` |
| `grok.applySkipped` | `Selection saved. The Grok config was not changed.` |
| `grok.saveApply` | `Save & apply` |
| `grok.saving` / `grok.applying` | `Saving…` / `Applying…` |
| `grok.unsaved` / `grok.upToDate` | `Unsaved changes` / `Selection is up to date` |
| `grok.excludedNotice` | `{count} models are switched off. Apply to update your Grok config.` |
| `grok.toggleModel` | `Register {id} with Grok` |
| `grok.search` | reuse `models.search` instead — no new key |

ko/ja/zh/de/ru translated in the same commit; `bun run lint:i18n` is the gate.

## TESTS

`gui/tests/grok-switch.test.tsx` (NEW, MOUNTED — audit blocker 7):

- with candidates present, each row renders a switch reflecting `excluded`;
- flipping a switch marks the page dirty and enables Save;
- Save PUTs `{ excluded: [...] }` and clears dirty;
- `Save & apply` calls both endpoints in order, and a response carrying
  `skippedReason` renders the "not changed" message rather than a success —
  activation evidence for the policy-skip branch;
- a failed PUT surfaces an error notice and leaves the switches dirty (no false
  success);
- with `present: false` (no Grok installed), the switches still render and the empty
  state names the next action.

`gui/tests/grok-group-view.test.ts` (NEW, pure): `grokGroupView(candidates, aliasById,
excluded, group)` covers counting, native/routed partition, registered-first ordering,
and the "switched-off model shows `—` for alias" case.

Locale coverage stays a source-level loop over the six dictionaries, as in the existing
`gui/tests/grok-page.test.ts`.

## Closing gates (this phase owns the full run)

| Command | Expected |
|---------|----------|
| `bun run typecheck` | clean |
| `bun run test` | pass; any pre-existing failure named as baseline |
| `cd gui && bun run test` | pass |
| `bun run lint:gui` | clean |
| `bun run lint:i18n` | clean |
| `bun run privacy:scan` | clean |
| `bun run build:gui` | succeeds |
| headless render of both pages | Desktop: Opus open on top, rows collapsed, one row expanded. Grok: two groups, switches, dirty bar. Screenshots persisted under this unit. |

## D-phase record

`050_closeout.md` records the terminal outcome, the captured evidence per criterion, and
anything that did not improve (LOOP-PESSIMIST-01).
