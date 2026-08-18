# 001 — live reproduction evidence (research, no diffs)

Environment: sandboxed backend `bun run src/cli/index.ts start --port 10199` with
`OPENCODEX_HOME=/tmp/ocx-gui-perf/home` (isolated from the user's instance on 10100),
Vite dev server on http://localhost:5199 with `OPENCODEX_PROXY_TARGET=http://127.0.0.1:10199`.
Browser: in-app browser, raw CDP (Network + Fetch domains) for fault injection.

## E0 — baseline request rate (performance criterion)

All 9 nav tabs visited (~1s each), then 31s dwell on Dashboard, idle sandbox, page
otherwise untouched. CDP `Network.requestWillBeSent` count:

    48 requests / 31s on Dashboard alone:
      /api/system/memory x5   /healthz x6   /api/providers x5   /api/v2 x5
      /api/sidecar-settings x5   /api/shadow-call-settings x5   /api/settings x5
      /api/injection-model x5   /api/effort-caps x5
      /api/startup-health x1    /api/diagnostics/project-config x1

i.e. ~1.5 req/s steady-state on one visible tab, ~9 concurrent 5s store pollers.

## E1 — H1: one hung request wedges its store permanently

CDP `Fetch.enable` on `/api/settings` (XHR+Fetch resourceTypes), never continue the
paused request = a server that accepts but never answers.

- 2 requests paused at mount (StrictMode first + live second), then ZERO further
  /api/settings attempts measured over 12s and again over 40s — the 5s poll tick
  skipped the wedged store every time (client-resource.ts:212).
- Store snapshot stays refreshing:true; a cold key would show its skeleton forever.
  Exit paths today: F5, manual refresh(), or unmount/remount of every subscriber.

## E2 — H2: stalled 401 re-bootstrap wedges ALL management fetches

Injection: fulfill every /api/* with 401 (real JSON body), stall /opencodex-session
forever. Observed during the 401 wave: 3 requests fulfilled 401, 1 bootstrap request
stalled. Only 3 /api requests ever hit the network because every later call joined
the pending `resolutionInFlight` promise client-side (api.ts:167-169).

Recovery phase: interception narrowed so /api/* flows to the REAL healthy server
and only /opencodex-session stays stalled. Measured over the next 40s:

    /healthz x2 (the 30s App poll — alive)
    /api/*   x0 — nothing reaches the network, nothing settles, forever

Cold tab opened in this state (Storage): "Scanning storage…" + 11 skeleton nodes,
indefinite (screenshot: /tmp/ocx-gui-perf/shots/wedged-storage.png during session;
regenerable by re-running this scenario). This is the user-reported symptom.

## E3 — post-heal stickiness of non-polled stores

After fully disabling interception (network healthy again), NEW cold tabs recover
(Usage fetched /api/usage twice and rendered). The Storage store — non-polled,
cold-mounted during the wedge — NEVER refired: 0 /api/storage requests in the
following 10s+, skeleton forever. Non-polled stores have no retry path at all once
their single attempt is lost inside the auth wedge (no poll tick, no visibility
listener without pollMs — client-resource.ts:175 installs it only while polling).

CORRECTION (2026-08-16, WP2 verification): the post-heal portion of this
observation was polluted by a test-harness artifact — the raw-CDP channel rejects
`Fetch.disable` (silently, via my own catch), so interception never actually
cleared and "heal" phases kept pausing requests. The mechanism claim stands on the
code (a non-polled cold store whose single attempt dies has no refire path), and
WP1's deadline converts it into a settled failed-cold with a working retry; but
the specific "never recovered even after heal" live observation is withdrawn as
evidence. The corrected end-to-end result (WP2 D addendum): after a real heal,
ALL tabs recover automatically with no reload.

## E4 — hidden-tab emulation limit

The in-app browser keeps background tabs `visibilityState: "visible"` (verified by
opening+selecting a second tab). Hidden-tab verification therefore runs as
happy-dom tests driving visibilityState directly (pattern already established in
gui/tests/client-resource-poll.test.tsx:64-74), not live emulation.

## Server-side note

`/opencodex-session` is served by a static HTML responder (src/server/gui-static.ts:102)
and is fast on a healthy loopback server; the defect is that the CLIENT has no
deadline on this app-wide critical path, so any stall (event-loop stall, proxy
restart mid-request, remote dashboard over a slow link) wedges the page. Sessions
expire every 5 minutes (api.ts:101-107), so the exposure re-arms periodically —
matching "stuck again a while after every refresh."

## E5 — user addendum: "refresh → it loads/gets stuck AGAIN" (recurrence)

User report (2026-08-16, mid-investigation): pressing refresh does not cure it —
the loading state comes back. Consistent with the two mechanisms above:

1. F5 clears module state and mints a fresh session via meta tags, so the first
   seconds work; the next 5-minute session expiry re-enters the 401 → re-bootstrap
   path (H2), and any single hung management route re-wedges its store (H1). Refresh
   resets the clock, it does not remove the mechanism.
2. The cold-mount fan-out right after F5 (~15-20 concurrent /api requests across
   tabs, including endpoints documented as slow: /api/usage?range=30d ~5s cold,
   Providers.tsx:99-102; live model discovery, Models.tsx:406-408) maximizes the
   chance that at least one request stalls or 401s immediately, which is why the
   stuck state can reappear almost immediately after a refresh.

Implication for the fix: recovery must not depend on page lifetime or on the server
never stalling. Every request needs a deadline that settles the store, and the auth
resolution must be bounded and abort-aware — both lands in WP1/WP2.
