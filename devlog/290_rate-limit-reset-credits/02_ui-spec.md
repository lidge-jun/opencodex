# 290-02 Rate-Limit Reset Credits — UI Specification

## Design Decision: Workspace Account Behavior

Per codex-rs source (`protocol/src/account.rs:50-59`):

```rust
pub fn is_workspace_account(self) -> bool {
    matches!(self,
        Self::Team | Self::SelfServeBusinessUsageBased | Self::Business
        | Self::EnterpriseCbpUsageBased | Self::Enterprise | Self::Edu
    )
}
```

Workspace plans: `team`, `business`, `enterprise`, `edu`, `self_serve_business_usage_based`, `enterprise_cbp_usage_based`
Personal plans: `free`, `go`, `plus`, `pro`, `pro_lite`

**codex-rs TUI behavior** (`usage.rs:13-14`):
- Workspace accounts → reset menu item **visible but disabled** + "No rate-limit resets available."
- Personal accounts → reset menu item enabled

**opencodex decision**: Match codex-rs — show ticket badge on ALL accounts,
but workspace accounts show `0` count with disabled/grayed styling.
Server-side, workspace accounts return `available_count: 0` (or null),
so this naturally resolves.

## Component Architecture

### Ticket Badge (inline in card-head)

Placement: between plan badge and NEXT SESSION badge.

```
┌─ card-head ──────────────────────────────────────────────┐
│ ● k***1@gmail.com  [pro]  [🎫 2]  [NEXT SESSION]    [×] │
└──────────────────────────────────────────────────────────┘
```

For workspace accounts:
```
┌─ card-head ──────────────────────────────────────────────┐
│ ● p***1@gmail.com  [team]  [🎫 0]                    [×] │
│                     ↑ grayed out, no click                │
└──────────────────────────────────────────────────────────┘
```

### Badge Variants

| Condition | Style | Clickable |
|-----------|-------|-----------|
| `resetCredits > 0` + personal plan | amber bg, amber text, ticket icon + count | Yes → opens popup |
| `resetCredits === 0` + personal plan | muted bg, muted text, ticket icon + "0" | Yes → opens popup (shows empty state) |
| Workspace plan (any count) | muted bg, faint text, ticket icon + "–" | No (disabled) |
| `resetCredits === undefined` (not fetched) | Hidden | — |

### Ticket List Popup (Modal)

Triggered by clicking the ticket badge.

```
┌──────────────────────────────────────────┐
│  🎫 Reset Credits           [×]         │
├──────────────────────────────────────────┤
│  k***1@gmail.com · pro                   │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │ 🎫 Reset Credit #1              │   │
│  │    Expires Jul 15, 2026 · 20d   │   │
│  │                        [Use]    │   │
│  └──────────────────────────────────┘   │
│  ┌──────────────────────────────────┐   │
│  │ 🎫 Reset Credit #2              │   │
│  │    Expires Jul 25, 2026 · 30d   │   │
│  │                        [Use]    │   │
│  └──────────────────────────────────┘   │
│                                          │
│  Credits expire 30 days after earning    │
└──────────────────────────────────────────┘
```

**Empty state** (0 credits, personal plan):
```
┌──────────────────────────────────────────┐
│  🎫 Reset Credits           [×]         │
├──────────────────────────────────────────┤
│  k***1@gmail.com · pro                   │
│                                          │
│  You don't have any reset credits.       │
│                                          │
│  Credits are earned monthly and via      │
│  the referral program.                   │
└──────────────────────────────────────────┘
```

**Note**: Individual ticket expiry dates are NOT available from the
`/wham/usage` API — it only returns `available_count: N`. The ticket
list will show N identical items without specific expiry dates. Instead:

```
┌──────────────────────────────────────────┐
│  🎫 Reset Credits           [×]         │
├──────────────────────────────────────────┤
│  k***1@gmail.com · pro                   │
│                                          │
│  You have 2 reset credits available.     │
│  Each credit resets your current hourly  │
│  and weekly usage limits instantly.      │
│                                          │
│  Credits expire 30 days after earning.   │
│                                          │
│          [Use 1 Credit]                  │
│                                          │
└──────────────────────────────────────────┘
```

Simplified to a single "Use 1 Credit" button since we can't enumerate
individual tickets (API limitation).

### Confirmation Dialog

```
┌──────────────────────────────────────────┐
│                                          │
│              ⚠️ (amber circle)           │
│                                          │
│        Use Reset Credit?                 │
│                                          │
│  This will instantly reset your current  │
│  hourly and weekly rate limits.          │
│  You have 2 credit(s) remaining.        │
│                                          │
│  This action cannot be undone.           │
│                                          │
├──────────────────────────────────────────┤
│           [Cancel]  [Use Credit]         │
└──────────────────────────────────────────┘
```

### Success Toast

After successful redemption, show a toast (not a modal):

```
✓ Rate limits reset! 1 credit remaining.
```

Uses existing `Notice` component with `tone="ok"`.

### Outcome Handling

| API `code` | UI Behavior |
|------------|-------------|
| `reset` | Close popup, toast "Rate limits reset! N credits remaining.", refresh quotas |
| `nothing_to_reset` | Alert: "No rate-limit window needs resetting right now." |
| `no_credit` | Alert: "No reset credits available." (race condition) |
| `already_redeemed` | Treat as success (idempotent) |
| HTTP error | Alert: "Failed to redeem reset credit. Please try again." |

## Implementation Details

### New State in CodexAuth.tsx

```tsx
// Add to component state
const [resetPopup, setResetPopup] = useState<AccountEntry | null>(null);
const [resetConfirm, setResetConfirm] = useState(false);
const [redeeming, setRedeeming] = useState(false);
```

### AccountQuota Extension

```tsx
// Add to existing interface (line 7-15)
interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;    // NEW
  updatedAt: number;
}
```

### isWorkspaceAccount Helper

```tsx
function isWorkspaceAccount(plan?: string): boolean {
  if (!plan) return false;
  const ws = ["team", "business", "enterprise", "edu",
              "self_serve_business_usage_based", "enterprise_cbp_usage_based"];
  return ws.includes(plan.toLowerCase());
}
```

### Ticket Badge in card-head (pool cards, line ~129-134)

Insert after plan badge, before NEXT SESSION badge:

```tsx
{/* After: {a.plan && <span className="badge badge-green">{a.plan}</span>} */}
<TicketBadge
  account={a}
  onClick={() => !isWorkspaceAccount(a.plan) && setResetPopup(a)}
/>
{/* Before: {isNext(a.id) && ... NEXT SESSION ...} */}
```

### Ticket Badge in card-head (main card, line ~104-111)

Insert after plan display, before CURRENT badge:

```tsx
{main && (
  <TicketBadge
    account={{ ...main, id: "__main__" } as AccountEntry}
    onClick={() => !isWorkspaceAccount(main.plan) && setResetPopup({ ...main, id: "__main__" } as AccountEntry)}
  />
)}
```

### TicketBadge Component

```tsx
function TicketBadge({ account, onClick }: { account: AccountEntry; onClick: () => void }) {
  const credits = account.quota?.resetCredits;
  if (credits === undefined) return null;

  const workspace = isWorkspaceAccount(account.plan);
  const hasCredits = credits > 0 && !workspace;

  return (
    <span
      className={`badge ${hasCredits ? "badge-amber" : "badge-muted"} ${workspace ? "badge-disabled" : "badge-clickable"}`}
      onClick={workspace ? undefined : (e) => { e.stopPropagation(); onClick(); }}
      title={workspace ? "Not available for workspace accounts" : `${credits} reset credit(s)`}
    >
      <IconTicket width={12} />
      {workspace ? "–" : credits}
    </span>
  );
}
```

### Reset Credit Popup (new modal, after existing confirm modal)

```tsx
{resetPopup && (
  <div className="modal-overlay" onClick={() => { setResetPopup(null); setResetConfirm(false); }}>
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      {!resetConfirm ? (
        <>
          <h3>🎫 {t("codexAuth.resetCreditsTitle")}</h3>
          <div className="card-sub">{resetPopup.email} · {resetPopup.plan}</div>
          <div style={{ margin: "16px 0" }}>
            {(resetPopup.quota?.resetCredits ?? 0) > 0 ? (
              <>
                <p>{t("codexAuth.resetCreditsAvailable", { count: resetPopup.quota?.resetCredits ?? 0 })}</p>
                <p className="card-sub">{t("codexAuth.resetCreditsDesc")}</p>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 12, width: "100%" }}
                  onClick={() => setResetConfirm(true)}
                  disabled={redeeming}
                >
                  {t("codexAuth.useOneCredit")}
                </button>
              </>
            ) : (
              <>
                <p className="faint">{t("codexAuth.noResetCredits")}</p>
                <p className="card-sub">{t("codexAuth.earnCreditsHint")}</p>
              </>
            )}
          </div>
          <p className="card-sub" style={{ fontSize: 11 }}>{t("codexAuth.creditsExpireNote")}</p>
        </>
      ) : (
        <>
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div className="confirm-icon"><IconAlert width={22} /></div>
            <h3>{t("codexAuth.confirmResetTitle")}</h3>
            <p className="card-sub">{t("codexAuth.confirmResetDesc", { count: resetPopup.quota?.resetCredits ?? 0 })}</p>
            <p className="faint" style={{ fontSize: 12 }}>{t("codexAuth.irreversible")}</p>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setResetConfirm(false)}>{t("codexAuth.cancel")}</button>
            <button className="btn btn-primary" onClick={() => handleRedeem(resetPopup.id)} disabled={redeeming}>
              {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
            </button>
          </div>
        </>
      )}
    </div>
  </div>
)}
```

### handleRedeem Function

```tsx
const handleRedeem = async (accountId: string) => {
  setRedeeming(true);
  try {
    const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    const result = await resp.json();
    if (result.code === "reset" || result.code === "already_redeemed") {
      setResetPopup(null);
      setResetConfirm(false);
      await load(true);
      const remaining = (resetPopup?.quota?.resetCredits ?? 1) - 1;
      setToast(t("codexAuth.resetSuccess", { remaining: Math.max(0, remaining) }));
      setTimeout(() => setToast(""), 5000);
    } else {
      alert(t(`codexAuth.resetOutcome.${result.code}`));
    }
  } catch {
    alert(t("codexAuth.resetError"));
  } finally {
    setRedeeming(false);
  }
};
```

### New i18n Keys

```typescript
// Ticket badge
"codexAuth.resetCreditsTitle": "Reset Credits",
"codexAuth.resetCreditsAvailable": "You have {count} reset credit(s) available.",
"codexAuth.resetCreditsDesc": "Each credit resets your current hourly and weekly usage limits instantly.",
"codexAuth.noResetCredits": "You don't have any reset credits.",
"codexAuth.earnCreditsHint": "Credits are earned monthly and via the referral program.",
"codexAuth.creditsExpireNote": "Credits expire 30 days after earning.",
"codexAuth.useOneCredit": "Use 1 Credit",

// Confirmation
"codexAuth.confirmResetTitle": "Use Reset Credit?",
"codexAuth.confirmResetDesc": "This will instantly reset your current rate limits. You have {count} credit(s) remaining.",
"codexAuth.irreversible": "This action cannot be undone.",
"codexAuth.useCredit": "Use Credit",
"codexAuth.redeeming": "Resetting...",

// Outcomes
"codexAuth.resetSuccess": "Rate limits reset! {remaining} credit(s) remaining.",
"codexAuth.resetOutcome.nothing_to_reset": "No rate-limit window needs resetting right now.",
"codexAuth.resetOutcome.no_credit": "No reset credits available.",
"codexAuth.resetError": "Failed to redeem reset credit. Please try again.",
```

### New CSS

```css
/* ticket badge variants */
.badge-clickable { cursor: pointer; transition: filter 0.12s; }
.badge-clickable:hover { filter: brightness(1.1); }
.badge-disabled { opacity: 0.5; cursor: default; }

/* confirm icon (amber circle) */
.confirm-icon {
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--amber-soft);
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 12px; color: var(--amber);
}
```

### New Icon: IconTicket

```tsx
// Add to gui/src/icons.tsx
export function IconTicket(props: { width?: number }) {
  return (
    <svg width={props.width ?? 16} height={props.width ?? 16} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" />
    </svg>
  );
}
```

## File Change Summary (Phase 3 only)

| Action | File | Change |
|--------|------|--------|
| MODIFY | `gui/src/pages/CodexAuth.tsx` | AccountQuota + TicketBadge + popup + redeem handler |
| MODIFY | `gui/src/i18n/en.ts` | 14 translation keys |
| MODIFY | `gui/src/styles.css` | badge-clickable, badge-disabled, confirm-icon |
| MODIFY | `gui/src/icons.tsx` | IconTicket SVG |
