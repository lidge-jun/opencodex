# 020 GUI usage stampede

Canonical in-document resource:
- key: usage-summary-30d:${apiBase}:all
- type: full /api/usage JSON (UsageSummary30d / UsageResponse)
- fetcher: shared GET /api/usage?range=30d, no rank transform inside the resource

Callers that MUST use that key and derive locally:
- gui/src/pages/use-dashboard-data.ts (remove pollMs 60000; change key off dashboard-usage)
- gui/src/pages/Providers.tsx (replace add-provider-usage)
- gui/src/components/AddProviderModal.tsx (replace add-provider-usage)
- gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx (delete raw fetch; subscribe to the keyed resource)

Codex-only: usage-summary-30d:${apiBase}:codex in useCodexAccountPool.ts; remove pollMs only; do not share the all-surface store.

Usage.tsx stays on its own range/surface key with no poll.

MODIFY gui/tests/dashboard-contracts.test.ts: expect usage-summary-30d key and the absence of pollMs: 60_000 on that resource.
