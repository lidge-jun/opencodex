# Codex quota registration browser verification

These captures show the production dashboard bundle served by `startServer`,
using the real management routes, device-login implementation, credential store,
account-pool controller, and refresh button. They are not component fixtures.

The server used an isolated OpenCodex/Codex home. Only external provider responses
were mocked: device authorization, token exchange, WHAM usage, and the completed
inference stream. The account identity and credentials are synthetic. The empty
native-main home explains the separate Main Account warning in both screenshots.
No live OpenAI account was used or charged.

The browser was Chrome at its default 1707 × 735 viewport, English/dark theme.
Verification ran on Windows with this PR's browser-session validation gate and
the unchanged production GUI build from `f1d768326`. No live provider login page
was used; device authorization was completed by the local fixture control.

1. Open Codex Set → Multi-auth, click Add, enter an account ID, and choose Device
   code login. Authorize through the mock device service.
2. The actual token exchange and authenticated usage read return a Pro account
   with weekly usage at 100%. Registration persists it as validation pending:
   one usage read, zero model calls, and no successful-validation timestamp.
   The completion notice also says validation is pending; no model-selection
   dialog opens for this unroutable account.
3. Reload the page and click Refresh quotas while usage is still 100%.
   The account remains pending. Cumulative counts: two usage reads, zero model
   calls. The pending screenshot shows the status and the missing selection button.
4. Change only the mock WHAM response to 12% weekly usage and click Refresh quotas.
   The server receives a completed validation response. Cumulative counts:
   three usage reads, one model call. The pending flag clears, the validation
   timestamp is persisted, and “Use this account next” appears.
5. Select the recovered account and confirm the dialog. The stored config reports
   `weekly-demo` as the active account.

Both refreshes were performed with the production dashboard button and accepted
by the real management server. Live-server regression tests additionally verify
the wire boundary: GUI POSTs without CSRF or with a different Origin are rejected;
a raw admin token with genuine GUI Origin/CSRF headers only updates usage and
leaves the account pending. Only the authenticated GUI session completes model
validation. GET quota refreshes remain observational.

| Capture | Weekly usage | Pending | Model calls so far |
| --- | --- | --- | --- |
| `codex-quota-pending.png` | 100% | Yes | 0 |
| `codex-quota-recovered.png` | 12% | No | 1 |

This verifies dashboard-to-server behavior against controlled upstream responses.
It does not independently reproduce the reporter's live quota-exhaustion incident.
