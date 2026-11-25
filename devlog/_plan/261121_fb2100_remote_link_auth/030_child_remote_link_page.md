# 030 #8985: the Child's Remote Link page reads its own status

Problem: on a connected Remote Link Child the page asks `GET /api/machine/hub-relay/api/link/status?children=1`.
`/api/link/status` is not a Home read the relay allows, so the Child answers `403 link_child_read_only`; the page keeps
`status === null`, shows "Remote link request could not be completed" and the off switch, and offers no way out of
the link. The Child serves its own status on its machine listener (`src/client/machine-listener.ts`), the same base
the diagnostics section already uses.

Second gap found while tracing it: `gui/src/api.ts` `classify()` attaches a session only to `/api/machine/*` on the
machine target, so a dashboard request to the Child's own `/api/link/status` or `/api/link/diagnostics` would leave
without one and get 401. On a link Child those two paths are machine-plane requests.

Decision (coordinator): no browser disconnect. The Child listener refuses dashboard-session writes by design (a
loopback session proves possession, not presence). The page shows the commands instead.

Diff:

- `gui/src/api.ts`: on a link Child, `/api/link/status` and `/api/link/diagnostics` under the machine target
  classify as the machine plane.
- `gui/src/pages/RemoteLink.tsx`: `statusApiBase` (default `apiBase`) and `statusSessionReady` (default
  `sessionReady`) drive the status read, its poll and the page's session gate; Home operations keep `apiBase` and the
  shared readiness (audit round 1, blocker 4). With `childLink` and `status.role === "child"` the page renders
  `RemoteLinkChildDisconnect`.
- `gui/src/pages/RemoteLinkChildDisconnect.tsx`: "Disconnect this computer" with two copyable commands,
  `ocx disconnect --expect-link <linkId>` (refuses unless this machine is still on that link) and `ocx restart`,
  plus a pointer to removing the Child from the Home's page. The link id comes from `/api/machine/status`.
- `gui/src/App.tsx`: passes `statusApiBase={targets.link ? machineBase : sharedBase}`,
  `statusSessionReady={targets.link ? hasApiSession("machine") : sharedSessionReady}`, `childLink={targets.link}`.
- `gui/src/i18n/remote-link-child-copy.ts`: lane-owned copy, 11 locales, spread into each locale file.

Tests: `gui/tests/remote-link.test.tsx` (a Child reads status from its machine base, never the relay, and shows the
commands with its link id; a standalone or Home never shows the panel), `gui/tests/api-auth-memory.test.ts` (on a link
Child the two paths carry the machine session; on a standalone they classify as before).

Verification: those files, `cd gui && bun test tests` (focused), `bun run lint:i18n`, `cd gui && bun run lint`,
`cd gui && bun run build`, `bun run typecheck`.

Follow-ups (not here): the leftover `Claude-3p/configLibrary` that fails Child sync and then blocks disconnect
(#8985 item 2), and a guided Home -> Child setup flow (#8985 item 3).

