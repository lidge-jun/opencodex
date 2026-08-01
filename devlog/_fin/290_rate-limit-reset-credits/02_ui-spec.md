# 290-02 Rate-Limit Reset Credits — UI Specification

## Design Decision: Account Plan Behavior

**Correction (2026-06-27): do not exclude workspace/team plans from reset-credit lookup.**
Live WHAM probes showed `team` accounts can return `rate_limit_reset_credits.available_count`
and can be queried through the same reset-credit endpoint as personal accounts. The UI must
therefore treat the upstream `resetCredits` value as authoritative instead of disabling the
ticket badge from `plan_type`.

Per codex-rs source (`protocol/src/account.rs:50-59`):

```rust
pub fn is_workspace_account(self) -> bool {
    matches!(self,
        Self::Team | Self::SelfServeBusinessUsageBased | Self::Business
        | Self::EnterpriseCbpUsageBased | Self::Enterprise | Self::Edu
    )
}
```

The old codex-rs-derived assumption was:
- Workspace accounts always have no reset credits.
- Workspace accounts should show a disabled reset menu.

That assumption is not true for current ChatGPT team accounts. Current opencodex behavior:
- If `resetCredits` is a number, show a clickable ticket badge for any plan.
- If `resetCredits > 0`, use the amber badge.
- If `resetCredits === 0`, use the muted badge and allow the empty-state popup.
- If `resetCredits === undefined`, hide the badge because the value has not been fetched.

## Component Architecture

### Ticket Badge (inline in card-head)

Placement: between plan badge and NEXT SESSION badge.

```
┌─ card-head ──────────────────────────────────────────────┐
│ ● k***1@gmail.com  [pro]  [🎫 2]  [NEXT SESSION]    [×] │
└──────────────────────────────────────────────────────────┘
```

For team accounts with credits:
```
┌─ card-head ──────────────────────────────────────────────┐
│ ● p***1@gmail.com  [team]  [🎫 1]                    [×] │
│                     ↑ clickable; opens ticket popup       │
└──────────────────────────────────────────────────────────┘
```

### Badge Variants

| Condition | Style | Clickable |
|-----------|-------|-----------|
| `resetCredits > 0` | amber bg, amber text, ticket icon + count | Yes → opens popup |
| `resetCredits === 0` | muted bg, muted text, ticket icon + "0" | Yes → opens popup (shows empty state) |
| `resetCredits === undefined` | Hidden | — |

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

### Ticket Badge in card-head (pool cards, line ~129-134)

Insert after plan badge, before NEXT SESSION badge:

```tsx
{/* After: {a.plan && <span className="badge badge-green">{a.plan}</span>} */}
<TicketBadge
  account={a}
  onClick={() => setResetPopup(a)}
/>
{/* Before: {isNext(a.id) && ... NEXT SESSION ...} */}
```

### Ticket Badge in card-head (main card, line ~104-111)

Main card has NO plan badge in `card-head` (plan is in `card-sub` at line 112).
Insert between `<strong>` (line 106) and CURRENT/NEXT badge (line 107):

```tsx
        <div className="card-head">
          <span className="dot dot-green" />
          <strong>{t("codexAuth.mainAccount")}</strong>
          {/* INSERT TicketBadge HERE */}
          {main && (
            <TicketBadge
              account={{ ...main, id: "__main__" } as AccountEntry}
              onClick={() => setResetPopup({ ...main, id: "__main__" } as AccountEntry)}
            />
          )}
          <span className={`badge ${!activeId ? "badge-primary" : "badge-muted"}`}>
```

Note: `__main__` consume path uses `readCodexTokens()` in the backend,
not `getValidCodexToken()`. This is already handled in `00_plan.md` §1.2.

### TicketBadge Component

```tsx
function TicketBadge({ account, onClick }: { account: AccountEntry; onClick: () => void }) {
  const credits = account.quota?.resetCredits;
  if (credits === undefined) return null;

  const hasCredits = typeof credits === "number" && credits > 0;

  return (
    <button
      type="button"
      className={`badge ${hasCredits ? "badge-amber" : "badge-muted"} badge-clickable`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={`${credits} reset credit(s)`}
    >
      <IconTicket width={12} />
      {credits}
    </button>
  );
}
```

Uses `<button>` instead of `<span>` for accessibility (keyboard focus, screen reader).
The `badge-clickable` class must not override `background`, `border`, or `font`;
the visual badge variant (`badge-amber`, `badge-muted`, `badge-primary`) owns those styles.
Ticket, plan, and session-state badges must render inside the same `card-badges`
inline-flex group, so a reset ticket never replaces or overlaps `NEXT SESSION`.

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
    if (!resp.ok) {
      alert(t("codexAuth.resetError"));
      return;
    }
    const result = await resp.json();
    if (result.code === "reset" || result.code === "already_redeemed") {
      const prevCredits = resetPopup?.quota?.resetCredits ?? 1;
      setResetPopup(null);
      setResetConfirm(false);
      await load(true);
      // Use prevCredits captured before clearing resetPopup (avoids stale closure)
      setToast(t("codexAuth.resetSuccess", { remaining: Math.max(0, prevCredits - 1) }));
      setTimeout(() => setToast(""), 5000);
    } else {
      // Explicit key mapping instead of dynamic template (TKey type safety)
      const msg = result.code === "nothing_to_reset"
        ? t("codexAuth.resetNothingToReset")
        : result.code === "no_credit"
          ? t("codexAuth.resetNoCredit")
          : t("codexAuth.resetError");
      alert(msg);
    }
  } catch {
    alert(t("codexAuth.resetError"));
  } finally {
    setRedeeming(false);
  }
};
```

### New i18n Keys (en.ts — 15 keys)

```typescript
// Ticket badge + popup
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

// Outcomes (explicit keys, not dynamic template)
"codexAuth.resetSuccess": "Rate limits reset! {remaining} credit(s) remaining.",
"codexAuth.resetNothingToReset": "No rate-limit window needs resetting right now.",
"codexAuth.resetNoCredit": "No reset credits available.",
"codexAuth.resetError": "Failed to redeem reset credit. Please try again.",
```

**Must also add same keys to `ko.ts` and `zh.ts`** — the i18n system
uses `Record<TKey, string>` so missing keys cause TypeScript errors.

Replace popup title emoji `🎫` with `<IconTicket width={16} />`
to match existing UI pattern (icons, not emoji).

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

Must follow existing pattern in `icons.tsx` (arrow fn, `P` type, `S()` helper):

```tsx
// Add to gui/src/icons.tsx — same pattern as other icons
export const IconTicket = (p: P) => (
  <svg {...S(p)}>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    <path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" />
  </svg>
);
```

## Frontend Employee Review Fixes

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | High | Main card insertion point wrong | Corrected: between `<strong>` and CURRENT badge |
| 2 | High | Workspace disabled assumption contradicted live team credits | Plan no longer gates reset-credit badge; upstream `resetCredits` is authoritative |
| 3 | High | `__main__` consume path | Noted: backend handles via `readCodexTokens()` (see 00_plan.md §1.2) |
| 4 | Medium | `handleRedeem` stale closure | Capture `prevCredits` before clearing `resetPopup` |
| 5 | Medium | `ko.ts`/`zh.ts` missing | Added note: must add keys to all locale files |
| 6 | Medium | IconTicket pattern mismatch | Changed to arrow fn + `P` type + `S()` helper |
| 7 | Medium | Dynamic i18n key type violation | Changed to explicit `switch` mapping |
| 8 | Low | `isWorkspaceAccount` missing aliases | Obsolete: removed workspace gating entirely |
| 9 | Low | `resp.ok` check missing | Added `if (!resp.ok)` guard |
| 10 | Low | Emoji in modal title | Changed to `<IconTicket>` |
| 11 | Low | `<span>` for clickable badge | Changed to `<button>` with `aria-label` |

## File Change Summary (Phase 3 only)

| Action | File | Change |
|--------|------|--------|
| MODIFY | `gui/src/pages/CodexAuth.tsx` | AccountQuota + TicketBadge + popup + redeem handler |
| MODIFY | `gui/src/i18n/en.ts` | 15 translation keys |
| MODIFY | `gui/src/i18n/ko.ts` | 15 translation keys (Korean) |
| MODIFY | `gui/src/i18n/zh.ts` | 15 translation keys (Chinese) |
| MODIFY | `gui/src/styles.css` | badge-clickable, badge-disabled, confirm-icon |
| MODIFY | `gui/src/icons.tsx` | IconTicket SVG (arrow fn + S() helper) |
