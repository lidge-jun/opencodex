# 020 — Layer 2: GUI Cursor tab, detail page, overview row, DSH label

Branch codex/cursor-integration-tab (base codex/cursor-integration-status). PR 2 of 3.
Body mentions gui -> screenshot required.

## File map

| Path | Action |
|---|---|
| gui/src/pages/integrations/integration-tabs.ts | MODIFY — IntegrationTab adds "cursor"; TABS inserts after grok |
| gui/src/app-routing.ts | MODIFY — INTEGRATION_TAB_HASHES adds "integrations/cursor" |
| gui/src/pages/integrations/overview-clients.ts | MODIFY — OverviewClientId adds "cursor"; OverviewSources.cursor; cursorRow() after grokRow |
| gui/src/pages/integrations/IntegrationsOverview.tsx | MODIFY — fetch status via useDataSurface like grok; pass into sources |
| gui/src/components/integration-marks.ts | MODIFY — NATIVE_MARKS.cursor |
| gui/src/pages/integrations/cursor-api.ts | NEW — type + fetch helper |
| gui/src/pages/integrations/CursorIntegrationPage.tsx | NEW |
| gui/src/pages/Integrations.tsx | MODIFY — render CursorIntegrationPage for "cursor" |
| gui/src/styles-integrations.css | MODIFY — .cursor-gateway-row, .cursor-model-table |
| gui/src/i18n/*.ts (9 locales) | MODIFY — tab.dsh "DSH"; tab.cursor "Cursor"; integrations.cursor.* keys |
| gui/tests/integrations-surfaces.test.tsx | MODIFY — cursor tab renders |
| gui/tests/cursor-integration-page.test.tsx | NEW — fixture payload states |

## Page layout

1. Title + intent line: "Cursor Private Inference talks to opencodex on loopback. Regular
   Cursor cannot; it needs a public HTTPS tunnel."
2. Detection card: Private Inference / Regular Cursor rows with badge + path. Regular-only:
   Notice with the tunnel explanation and the guide link.
3. Gateway card: "Paste into Settings > Models > Gateway" — Base URL and API Key rows, mono
   value + Copy; credential mode shows "your API key" + link to the API Keys tab.
4. Connection card: "Last request from Cursor: 3 min ago (Cursor/3.18.25)" or "Not seen since
   the proxy started — press Refresh model list in Cursor." Refresh every 15 s while active.
5. Models card: table id / Reasoning / Context.
6. Guide link.

## Overview row

    state = !payload ? "unknown" : !privateInference.installed ? "not-installed" : lastSeen && now - at < 86_400_000 ? "current" : "absent"
    installed = privateInference.installed; applied = state === "current"; toggle = null

## Screenshot

Scratch-home dev proxy (OPENCODEX_HOME/CODEX_HOME/GROK_HOME/HOME -> mktemp) on a scratch
port with the built GUI; open #integrations/cursor; capture; commit PNG under the devlog
unit on the branch and link the raw path in the PR body.

## Checks

    cd gui && bun x tsc --noEmit ; bun run lint:gui ; bun run build:gui
    bun test gui/tests/integrations-tab-coverage.test.ts gui/tests/integration-marks.test.ts gui/tests/integrations-surfaces.test.tsx gui/tests/cursor-integration-page.test.tsx gui/tests/claude-desktop-locale.test.ts gui/tests/apikeys-layout.test.ts

