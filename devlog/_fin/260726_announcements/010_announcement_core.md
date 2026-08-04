# 010 — WP-B: announcement catalog, baseline, and seen state

The substrate. No UI in this phase — the surface (WP-C) and onboarding (WP-D)
both consume what lands here.

## NEW `src/announcements/catalog.ts`

The declaration source. Adding an entry here is the ONLY way an announcement
exists — nothing is derived from tags, changelog or release notes, because those
regenerate every release and would make "announce" the default.

```ts
export type AnnouncementKind = "decision" | "info";

export interface Announcement {
  /** Stable id. Never reused — dismissal is keyed on it. */
  id: string;
  /** ISO date the item was DECLARED, not the release date. Drives the baseline cut. */
  declaredAt: string;
  kind: AnnouncementKind;
  /** i18n key for the title; body key is `${titleKey}.body` by convention. */
  titleKey: TKey;
  /** Optional in-app route the announcement points at, e.g. "grok". */
  page?: Page;
}

export const ANNOUNCEMENTS: readonly Announcement[] = [];
```

**The array ships EMPTY.** This is the deliberate consequence recorded in
`000_plan.md`: the release that introduces this system announces nothing. Landing
it with the Grok/Desktop items already inside would backfill on day one — exactly
what rule 2 forbids — because every existing user's baseline is written by that
same release.

`kind` drives the surface in WP-C: `decision` may use a modal, `info` may not.

## MODIFY `src/types.ts`

Add to `OcxConfig`, beside the existing optional feature fields:

```ts
+  /**
+   * Announcement state. `baseline` is stamped once, on the first run that carries the
+   * announcement system, and only items declared after it are ever shown — an existing user
+   * upgrading in must not receive a backlog. `dismissed` holds acknowledged ids.
+   */
+  announcements?: {
+    baseline?: { at: string; version: string };
+    dismissed?: string[];
+  };
```

**`firstRun` was removed** (see `031` § D1). It recorded whether the config FILE
was absent at stamp time, but the file is written by `ocx init`, startup seeding,
port fallback and OAuth login — so it measured whether the user opened the
dashboard before the CLI, not whether they were new. WP-D derives newness from
an explicit install marker instead (`031` § D1′), written once by the first
`saveConfig` that creates the file:

```ts
+  /** Written once, by the first saveConfig that creates the file. Never inferred. */
+  install?: { createdAt: string; createdByVersion: string };
```

That marker is independent of the announcement baseline and belongs beside it in
`OcxConfig`, not inside `announcements`: it describes the installation, while
`baseline` describes when announcements started being observed.

## NEW `src/announcements/state.ts`

```ts
/** Stamps the baseline exactly once. Returns the config unchanged if one exists. */
export function ensureAnnouncementBaseline(config: OcxConfig, now: Date, version: string): boolean;

/** Announcements declared after the baseline and not yet dismissed. */
export function pendingAnnouncements(
  config: OcxConfig,
  catalog: readonly Announcement[] = ANNOUNCEMENTS,
  now?: Date,
): Announcement[];

/** Records a dismissal. Unknown ids are ignored rather than stored. */
export function dismissAnnouncement(config: OcxConfig, id: string): boolean;
```

Rules `pendingAnnouncements` must enforce, each mapping to a boundary case in
`000_plan.md`:

- no baseline yet → return `[]` (the caller stamps it; nothing is owed retroactively);
- `declaredAt <= baseline.at` → excluded, permanently;
- id in `dismissed` → excluded;
- `declaredAt` in the future relative to `now` → excluded (**fail closed**: a clock
  skew must hide announcements, never reveal the whole catalog);
- unparseable `declaredAt` → excluded, not thrown; a malformed catalog entry must
  not take down the endpoint.

Ordering: oldest `declaredAt` first, so the surface shows them in the order they
happened.

## MODIFY `src/server/management/config-routes.ts`

Two routes beside the existing `/api/update/*` block:

```
GET  /api/announcements       -> { baseline, pending: Announcement[] }
POST /api/announcements/dismiss  body { id } -> { ok: true }
```

`GET` stamps the baseline when absent and persists it, so the first call from any
surface establishes the cut. `POST` validates the id against the catalog and
returns 400 for an unknown one — the dismissed list must not accumulate arbitrary
strings from a request body.

## Where the baseline is stamped

On the `GET` route rather than at proxy startup. Startup stamping would mean a
user who installs and never opens the dashboard still burns their baseline, and a
later first visit would then show nothing. Stamping on first read ties the cut to
the first moment a surface could actually have displayed something.

## TESTS — `tests/announcements.test.ts` (NEW)

The six boundary cases from `000_plan.md`, each named after the user situation:

1. fresh install with an empty catalog → baseline stamped, nothing pending;
2. **existing user upgrading in with a non-empty catalog → nothing pending** (the
   no-backfill guarantee; this is the case the whole design exists for);
3. announcement declared after the baseline → pending once;
4. after dismissal → not pending, and the id is persisted;
5. announcement declared before the baseline → never pending, even after a later
   version bump;
6. `declaredAt` in the future, and an unparseable `declaredAt` → both excluded, no
   throw.

Plus: `ensureAnnouncementBaseline` is idempotent — a second call must not move an
existing stamp, or every restart would silently re-cut the timeline.

Mutation check: remove the `declaredAt <= baseline.at` comparison and case 2 must
fail.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/announcements.test.ts` | pass |
| `bun run typecheck` | exit 0 |
