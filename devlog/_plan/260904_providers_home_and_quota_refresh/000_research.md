# 000 — Research: Providers surface has no way home, and no way to refresh every quota

## Why this unit exists

Two complaints from the same session on the Providers page, both about
navigation and control affordances rather than data correctness.

1. "여기서 다시 첫화면으로 돌아올 수가 없어" — from
   `http://localhost:10100/#providers`, there is no way back to the first
   screen.
2. The Provider Overview (`프로바이더 개요`) shows a stack of quota bars but
   offers no control to re-read them. Per-provider refresh exists; the
   aggregate view has none.

## Live evidence

Captured through the in-app browser against the running proxy on port 10100
(v2.43.0), viewport 850x1140 — the viewport the user was actually looking at.

### The brand is inert

`gui/src/App.tsx` builds one `brand` fragment and renders it twice: in the
`.mobile-topbar` (<=760px) and in the sidebar `.drawer-head`. Probing the live
DOM:

```json
{ "brandTag": "DIV", "brandCls": "brand", "brandClickable": false }
```

It is a plain `<div>`: no click handler, no `href`, no `role`, not in the tab
order. Clicking the opencodex logo does nothing. That is the single most
universal "go home" convention on the web, and on this dashboard it is dead.

### The sidebar is not the problem people think it is

Worth recording because it rules out the obvious first hypothesis. The sidebar
is `position: sticky; top: 0` and stays pinned:

```text
before: { pos: "sticky", top: 0, navTop: 68, innerH: 1425 }
after 10 scroll pages: { sbTop: 0, navTop: 68, navVisible: true }
```

So the 대시보드 nav row never scrolls away, and `#providers -> #dashboard`
navigation works when it is clicked. The gap is not a missing destination; it
is a missing affordance on the element users instinctively click first.

That distinction decides the fix. Adding a second "홈으로" row inside the
Providers header would be a duplicate top-level fork on a dense admin surface —
a Lazy-User Gate violation (do nothing / delete / absorb / demote, in that
order). The correct move is to make the existing, already-visible, already
twice-rendered brand do what it looks like it does.

### The overview header has one button

`ProviderOverviewDashboard.tsx` renders `.pws-dashboard-header` with the title
and a single ghost button, `JSON 편집`. The user marked exactly this row in the
browser comment: "이 밑 쯤에 넣으면 될것 같긴한데".

Below it sit the summary cards and the `사용량 제한` section, whose rows show
ages like "2분 전 확인" / "1시간 전 확인" — the UI already tells you the numbers
are stale, and then gives you nothing to do about it.

## What already exists (do not rebuild)

The forced-read machinery is complete and truthful; only the entry point is
missing.

- `gui/src/pages/Providers.tsx` owns `quotaRefresh {epoch, force}`,
  `quotaRefreshWaiters`, and `settleQuotaRefresh`. Its comment is explicit
  about why: a state bump is not an answer, so the resolver is parked on the
  page and settled by the shell that owns the actual read. "Without this a
  refresh button would flip back to idle and report success while the old
  numbers were still on screen."
- `ProviderWorkspaceShell.tsx` owns the only `/api/provider-quotas` read and
  appends `?refresh=1` when `quotaForceRefresh` is set, then calls
  `onQuotaRefreshSettled(ok)`.
- `ProviderUsage.tsx` and `ProviderAuthPanel.tsx` already render a per-provider
  refresh button over `onRefreshQuota(): Promise<boolean>`, with pending text
  and a settled ok/fail line, using `codexAuth.refreshQuota`,
  `codexAuth.refreshingQuota`, `codexAuth.quotaRefreshed`, and
  `codexAuth.quotaRefreshFailed`.

So both outcomes are small, and both are about surfacing an existing capability
rather than inventing one.

## Design read

```yaml
---
name: opencodex-providers-workspace
surface: existing dashboard (no new visual language)
---
```

Reading this as: a dense operator console for a local proxy, for a maintainer
who visits many times a day. Not a landing page. The governing design system
already exists in `gui/src/styles/`, so no concept generation applies here.

DESIGN_VARIANCE: 2
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dashboard/admin domain, repeated expert work; the brief is "I cannot
get home" and "I cannot refresh" — both minimize repeated MOTIONS, not
decisions. Adding visual variance here would be domain-wrong.

Do's: reuse `btn btn-ghost btn-sm`, the existing icon set, and the existing
quota-refresh i18n keys; keep both controls where the eye already goes.
Don'ts: no new nav row, no new panel, no emoji, no motion, no second refresh
concept competing with the per-provider one.

## Out of scope

`src/` runtime, management API contracts, provider adapters, release scripts,
workflows, auth paths, `gui/dist`, and the existing per-provider refresh
controls beyond reuse.
