# 030 — Dashboard Home Connect card (wp4)

## NEW `gui/src/telemetry-profile-api.ts`

Typed client for `/api/telemetry/profile` (GET/POST/DELETE) and `/rank` with `createBoundedFetch`, parsers that drop
unknown fields, and `TELEMETRY_PROFILE_CHANGED_EVENT`. Errors carry the server `code`
(`agent_consent_required`, `telemetry_off`, `handle_taken`, `invalid`, `rate_limited`).

## NEW `gui/src/components/telemetry-profile-card.tsx`

Rendered by `Home.tsx` below the stat tiles (one import + one element). Hidden when the GUI runs as a Remote Link
Child, or when `available` is false, or when telemetry is not effective **and** no profile is connected.

States:

1. **Not connected** — title "Public profile & rank", one paragraph naming exactly what becomes public (handle, display
   name, colour, daily totals of requests and tokens, model families) and what never leaves (prompts, keys, accounts,
   e-mail, devices), a link to the guide. Collapsed form behind a "Connect" button: handle, display name, avatar colour
   swatches, an unchecked checkbox "I understand this profile is public", Connect (disabled until valid and checked).
   Errors map to localized messages; `agent_consent_required` says to use the dashboard in a normal session or the CLI.
2. **Connected** — avatar initial on the chosen colour, display name, @handle; three tiles Day / Week / Month with
   rank "#n of m", tokens (compact) and requests; top three model families for the month; "First rank appears after your
   first full UTC day" when nothing is ranked yet; "View leaderboard" link to
   `https://opencodex.me/dashboard/?profile=<handle>#leaderboard`; Disconnect (confirm step: "Delete your public profile
   and its data?").
3. **Deletion pending** — message plus Retry.
4. **Paused** — connected but telemetry off: "Paused while anonymous telemetry is off" (no auto-disconnect).

## Copy

User-supplied strings render as React text only (no `dangerouslySetInnerHTML`); the leaderboard link builds the
query with `URLSearchParams` and only for a handle that passes `PROFILE_HANDLE_RE` (test with `a-1-b2`).

NEW `gui/src/i18n/v2-pages/telemetry-profile-copy.ts` (`copyTable`, 11 columns like `proxy-copy.ts`), spread into each
locale catalogue the same way `proxyV2Copy` is.

## Tests

NEW `gui/tests/telemetry-profile-card.test.tsx`: visibility rules, connect disabled until checkbox, request body
shape, connected rank rendering, disconnect confirm + DELETE, pending state, Remote Link Child hidden. Screenshot of
both states for the PR via the `pr-assets` branch.


## Implementation record (wp4, eab9d1e49a)

- Process deviation: the card was written while the loop FSM was still at P; the A/B edges were advanced afterwards
  with the deviation stated in the attests. The plan doc had been audited in wp1, so the code follows an audited plan.
- `gui/src/telemetry-profile-api.ts` owns the wire parsing and `isValidProfileHandle` (moved out of the component
  file because oxlint's `react(only-export-components)` rule rejects non-component exports there).
- The card hides itself when `/api/telemetry/profile` is refused, which is how a Remote Link Child behaves (the path is
  not link-readable), as well as under `isConnectedRuntime()`.
- Avatar colours are a fixed hex map (no Tailwind classes generated from data).
- Screenshots for the PR (kept out of the branch): the empty connect form, and the connected state before any
  collector exists ("Rank is unavailable right now"), taken from a throwaway proxy in an isolated home.
- Verification: `gui/tests/telemetry-profile-card.test.tsx` (8 tests), full GUI suite 4109 pass, `lint:gui` and
  `build:gui` clean.

## Follow-up (wp4 second cycle)

The card refreshes on `TELEMETRY_STATUS_CHANGED_EVENT` (dispatched by `putTelemetryDecision` in
`gui/src/telemetry-api.ts`), so switching anonymous telemetry off in Proxy details shows the paused state, or hides the
card, without waiting for the 60-second poll. Test: dispatch the event after the server state changes and assert
the card follows.
