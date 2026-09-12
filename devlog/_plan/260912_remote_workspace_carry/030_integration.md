# Phase 3: integration

Depends on: phase 2. Source: `ba6f822cae53fcc4c91575a4c78f86f9944b6644`. Main owns implementation; tests execute only on hosted CI.

## Exact file map

| Change | Source | Destination |
| --- | --- | --- |
| MODIFY | [docs-site/astro.config.mjs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/docs-site/astro.config.mjs) | `docs-site/astro.config.mjs` |
| MODIFY | [docs-site/src/content/docs/guides/remote-hub.md](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/docs-site/src/content/docs/guides/remote-hub.md) | `docs-site/src/content/docs/guides/remote-hub.md` |
| NEW | [docs-site/src/content/docs/guides/remote-workspace.md](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/docs-site/src/content/docs/guides/remote-workspace.md) | `docs-site/src/content/docs/guides/remote-workspace.md` |
| MODIFY | [docs-site/src/content/docs/reference/cli.md](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/docs-site/src/content/docs/reference/cli.md) | `docs-site/src/content/docs/reference/cli.md` |
| MODIFY | [docs-site/src/content/docs/reference/management-api.md](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/docs-site/src/content/docs/reference/management-api.md) | `docs-site/src/content/docs/reference/management-api.md` |
| MODIFY | [gui/src/App.tsx](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/App.tsx) | `gui/src/App.tsx` |
| MODIFY | [gui/src/app-routing.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/app-routing.ts) | `gui/src/app-routing.ts` |
| MODIFY | [gui/src/i18n/de.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/de.ts) | `gui/src/i18n/de.ts` |
| MODIFY | [gui/src/i18n/en.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/en.ts) | `gui/src/i18n/en.ts` |
| MODIFY | [gui/src/i18n/fr.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/fr.ts) | `gui/src/i18n/fr.ts` |
| MODIFY | [gui/src/i18n/ja.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/ja.ts) | `gui/src/i18n/ja.ts` |
| MODIFY | [gui/src/i18n/ko.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/ko.ts) | `gui/src/i18n/ko.ts` |
| MODIFY | [gui/src/i18n/ru.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/ru.ts) | `gui/src/i18n/ru.ts` |
| MODIFY | [gui/src/i18n/tr.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/tr.ts) | `gui/src/i18n/tr.ts` |
| MODIFY | [gui/src/i18n/zh-TW.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/zh-TW.ts) | `gui/src/i18n/zh-TW.ts` |
| MODIFY | [gui/src/i18n/zh.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/i18n/zh.ts) | `gui/src/i18n/zh.ts` |
| NEW | [gui/src/pages/RemoteWorkspace.tsx](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/pages/RemoteWorkspace.tsx) | `gui/src/pages/RemoteWorkspace.tsx` |
| NEW | [gui/src/remote-workspace-command.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/remote-workspace-command.ts) | `gui/src/remote-workspace-command.ts` |
| NEW | [gui/src/styles-remote-workspace.css](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/styles-remote-workspace.css) | `gui/src/styles-remote-workspace.css` |
| MODIFY | [gui/src/styles.css](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/src/styles.css) | `gui/src/styles.css` |
| MODIFY | [gui/tests/fr-localization.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/tests/fr-localization.test.ts) | `gui/tests/fr-localization.test.ts` |
| MODIFY | [gui/tests/locale-parity.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/tests/locale-parity.test.ts) | `gui/tests/locale-parity.test.ts` |
| NEW | [gui/tests/remote-workspace.test.tsx](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/tests/remote-workspace.test.tsx) | `gui/tests/remote-workspace.test.tsx` |
| MODIFY | [gui/tests/sidebar-rows.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/gui/tests/sidebar-rows.test.ts) | `gui/tests/sidebar-rows.test.ts` |
| MODIFY | [src/cli/dispatch.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/cli/dispatch.ts) | `src/cli/dispatch.ts` |
| MODIFY | [src/cli/help.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/cli/help.ts) | `src/cli/help.ts` |
| MODIFY | [src/cli/registry.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/cli/registry.ts) | `src/cli/registry.ts` |
| MODIFY | [src/server/index.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/index.ts) | `src/server/index.ts` |
| MODIFY | [src/server/management-api.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/management-api.ts) | `src/server/management-api.ts` |
| MODIFY | [src/server/management/context.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/management/context.ts) | `src/server/management/context.ts` |
| NEW | [src/server/management/remote-workspace-routes.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/management/remote-workspace-routes.ts) | `src/server/management/remote-workspace-routes.ts` |
| MODIFY | [src/server/management/route-registry.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/management/route-registry.ts) | `src/server/management/route-registry.ts` |
| MODIFY | [src/server/ws-bridge.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/server/ws-bridge.ts) | `src/server/ws-bridge.ts` |
| MODIFY | [tests/cli-headless-parity.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/cli-headless-parity.test.ts) | `tests/cli/cli-headless-parity.test.ts` |
| MODIFY | [tests/loopback-listener-integration.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/loopback-listener-integration.test.ts) | `tests/server/loopback-listener-integration.test.ts` |
| NEW | [tests/remote-workspace-management.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-management.test.ts) | `tests/clients/remote-workspace-management.test.ts` |
| NEW | [tests/remote-workspace-server.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-server.test.ts) | `tests/clients/remote-workspace-server.test.ts` |

## Transformation contract

NEW files carry the complete immutable source body. For moved tests, rewrite source imports `../src/` to `../../src/`, helper imports `./helpers/` to `../helpers/`, and obsolete fake-server paths to their current fixture owner. Register every new test in both layout.json explicit and test-layout-expected.json. Source-file reads and subprocess fixture paths use tests/helpers/repo-root.ts. Shared existing files take only source PR hunks, preserving all newer dev behavior; resolve conflicts against the named owner before writing. All original adopted implementation receives the coauthor trailer.

Port original src/server/index.ts admission and WebSocket handlers into current owners after reading current decomposition. Keep runtimeRole=hub and no-Origin checks before lazy workspace imports. Browser mutations require gui-session. Pair exchange retains 32KiB bounded read, kernel-peer limiter and one-time device token. Add remote-workspace branch to all WsData consumers (open/message/close) with disconnect cleanup. Shutdown only touches already initialized workspace instances. Never import workspace modules from router.ts, lifecycle.ts or responses/core.ts.

CLI registration now also needs src/cli/capabilities.ts and generated skills/ocx surface sync. GUI follows current App routing, nav structure and all locale dictionaries; preserve existing browser consent and error handling. User docs distinguish provider gateway Remote Hub from executor Remote Workspace. Current structure ownership docs receive concise source-appropriate updates without copying obsolete numbered docs.

Reachable negatives: non-hub invocation; Origin-bearing pair/upgrade; missing/malformed/revoked bearer; admin-token attempt at dashboard mutation; excessive pairing body; ten invalid code attempts; unknown session/device/root; offline status and unavailable runtime. Original management/server tests plus new activation-isolation source guard must observe refusals and no optional activation. UI uses deterministic mocked API rendering, no live pairing. Screenshot must be generated/observed by an authorized renderer; absent render evidence is recorded as NOT VERIFIED, never borrowed from original screenshot.

## Data and enforcement chain

Required acceptance (not an established property of the pinned source): identity/capability creation comes from protocol builders and device root approval; serializers carry bounded versioned messages; strict parsers recover them; handshake/coordinator/executor consumers enforce capabilities and roots. GUI only displays public state. Tier: runtime boundary; executing surface: parser/auth/executor code. Known bypass: a process with the operator account can invoke host tools directly. Residual: local operator compromise is outside this process boundary. Wording: bounded remote tools, no claim of host-user isolation. Final layer for commands: OS confinement probe; unavailable means exec is not advertised.

## Verification and rollback

Local tests/build/typecheck/install NOT RUN by user instruction. Text comparison and git diff --check observe this change but are not product tests. Existing hosted CI command definitions are inspected before dispatch; final SHA evidence is recorded in phase 4. Revert this layer before its parent; no persistent state migrations are performed by this carry task.

## Explicit activation REMOTE-ARCH-005

NEW src/remote-control/workspace-activation.ts exports a side-effect-free guard requiring runtimeRole=hub AND process.env.OCX_REMOTE_WORKSPACE_ENABLED === "1". This guard imports only the config type. Pair and agent branches call it before dynamic import; disabled requests return 404. Management namespace returns a disabled status before importing runtime. Shutdown uses already retained workspace references or initialized-only lazy import only when explicitly enabled; a disabled Hub never creates identity or probes model CLIs. CLI pairing remains explicit Executor-local authorization and never modifies server environment. Document the opt-in variable and require an explicit environment choice to enable the feature. Test disabled Hub, non-Hub with flag, and enabled Hub, with no ambient inheritance in fixtures.

Existing-file conflicts observed by git apply --check: management-api.ts, management/context.ts and ws-bridge.ts. Port the namespace-dispatch addition into current management handler, append only type/dependency seam fields after current imports, and extend current WebSocket discriminator/handlers without replacing newer fields. The check was text applicability only, not a product test.
