# 050 — Truthful Codex dashboard toggle (#3406)

Work-phase: one full PABCD cycle. Closes #3406. Carries PR #3407 (supersedes; Co-authored-by: turin <koomj5258@gmail.com>).
Source evidence lane output is reproduced below verbatim (diff-level). Stale-check
against the current tree at this cycle's P before implementing.

---

## 1) VERDICT: CARRY_EXISTING_PR

#3406 is **not fixed**. Carry [PR #3407](https://github.com/lidge-jun/opencodex/pull/3407), preserving turin-dev’s credit.

Baseline correction: checkout HEAD is `6d9639165581546cdcebe96bc911446caabdd7d0`; local `origin/dev` is `980a9fbede123f411f52c8b061a05fb995ae159d`. Their diff does not touch the affected files. No files changed or tests run.

## 2) EVIDENCE

Current code retains all three defects:

- [IntegrationsOverview.tsx:691](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:691):  
  `pendingToggle.toggle === "claude-desktop" ? DESKTOP_DISABLE_COPY : GROK_DISABLE_COPY`
- [overview-clients.ts:191](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/pages/integrations/overview-clients.ts:191):  
  `function codexRow(payload: CodexRoutingPayload | null)` — no native desired-state input; line 198: `togglePath: null`.
- [IntegrationsOverview.tsx:431](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx:431):  
  `refreshNativeDetails` refreshes `nativeResource`, `claudeResource`, `grokResource` only. Successful Codex mutation calls it at line 467; **Codex routing is not refreshed**.
- [native-integration-routes.ts:686](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/native-integration-routes.ts:686):  
  `codexStatus(config, getConfigPath())` — OpenCodex’s path.
- [native-integration-routes.ts:165](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/native-integration-routes.ts:165):  
  `const desiredEnabled = config.clientIntegrations?.codex !== false;` — desired state already exists server-side.

Live PR metadata: **OPEN, draft, CONFLICTING**, head `38d45300a644dd0aa641a0a9b76f293169ab8ef9`. `gh pr view --json commits` confirms:

```text
Co-authored-by: turin <koomj5258@gmail.com>
```

## 3) DIFF-LEVEL CARRY PLAN

### MODIFY runtime/UI owners

**[IntegrationsOverview.tsx](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/pages/integrations/IntegrationsOverview.tsx)** — carry the PR’s localized Codex copy object and these edits:

```diff
 const refreshNativeDetails = () => {
   nativeResource.refresh();
+  codexResource.refresh();
   claudeResource.refresh();
   grokResource.refresh();
 };
```

```diff
- pendingToggle.toggle === "claude-desktop" ? DESKTOP_DISABLE_COPY : GROK_DISABLE_COPY
+ pendingToggle.toggle === "claude-desktop" ? DESKTOP_DISABLE_COPY
+   : pendingToggle.id === "codex" ? CODEX_DISABLE_COPY
+   : GROK_DISABLE_COPY
```

Also use `const toggleOn = row.toggleOn ?? row.applied` for **both** switch value and accessible action label; include Codex in native-refusal copy handling.

**[overview-clients.ts](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/pages/integrations/overview-clients.ts)**:

```diff
-function codexRow(payload: CodexRoutingPayload | null): OverviewRow {
+function codexRow(
+  payload: CodexRoutingPayload | null,
+  native: NativeStatus | undefined,
+  nativeSettled: boolean | undefined,
+): OverviewRow {
```

```diff
- toggleBlocked: null,
- togglePath: null,
+ toggleBlocked: native?.disableBlocked ?? null,
+ togglePath: native?.configPath ?? null,
```

Carry the PR branches: unsettled native read → unknown; settled-but-missing native row → no toggle; `installed` from native status; `toggleOn: native.desiredEnabled`; **badge/applied remain derived from `routingInjected`**. Pass the Codex native row and `sources.nativeSettled` from `buildOverviewRows`.

**[native-integration-routes.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/native-integration-routes.ts)**:

```diff
+import { join } from "node:path";
+import { getCodexHome } from "../../codex/paths";
…
- codexStatus(config, getConfigPath())
+ codexStatus(config, join(getCodexHome(), "config.toml"))
```

Leave Claude’s `getConfigPath()` and PUT/convergence logic unchanged.

### MODIFY translations/docs/tests

- Add the PR’s six `integrations.dialog.codex.*` keys to every existing locale: `en`, `de`, `fr`, `ja`, `ko`, `ru`, `tr`, `zh-TW`, `zh` under [gui/src/i18n](/Users/jun/.codex/worktrees/ef41/opencodex/gui/src/i18n).
- [codex-integration.md](/Users/jun/.codex/worktrees/ef41/opencodex/docs-site/src/content/docs/guides/codex-integration.md): carry the desired-switch/observed-badge and disable/re-enable paragraph; retain current voice-sideband documentation. Keep corresponding locale guides consistent.
- [integrations-overview-rows.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/gui/tests/integrations-overview-rows.test.ts): native fixtures; desired false while routing remains injected; effective path; disabled/absent result. Add unsettled/missing-native cases.
- [integrations-surfaces.test.tsx](/Users/jun/.codex/worktrees/ef41/opencodex/gui/tests/integrations-surfaces.test.tsx): carry mounted regression proving Codex title/path, no PUT before confirmation, correct PUT, and refreshed switch **and badge**.
- [overview-state-merge.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/gui/tests/overview-state-merge.test.ts): add `desiredEnabled: true` to native fixture.
- [native-codex-toggle.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/codex-integration/native-codex-toggle.test.ts): carry isolated `CODEX_HOME` directory setup/environment restoration and effective-config-path assertion.

**Layout correction:** do not recreate `tests/native-codex-toggle.test.ts` or invent a server duplicate. The existing test moved in `8b6e4542a` / #3516. Both [layout.json:798](/Users/jun/.codex/worktrees/ef41/opencodex/scripts/test-layout/layout.json:798) and [test-layout-expected.json:635](/Users/jun/.codex/worktrees/ef41/opencodex/tests/fixtures/test-layout-expected.json:635) map it to `codex-integration`. Existing-file modifications need no manifest edits; any new test needs both entries.

### Conflict handling

Verified base-to-current differences:

- `8b30d60b3` reverted the collapsed-client UI and lifted `statesResource` prop. **Keep current all-client rendering and current `mountOverview()` signature**; carry only Codex hunks.
- `413227888` / #3477 added journal deletion state/dialog adjacent to `pendingToggle`. Preserve it.
- Backend route and `overview-clients.ts` have no base-to-current changes; their carry hunks are straightforward.
- Preserve current locale additions and voice-sideband docs; do not replace whole files with PR versions.
- Retarget the moved backend test’s imports to existing `../../src/...` and `../helpers/...`.

### Focused verification plan—not executed

From repository root:

```bash
bun test tests/codex-integration/native-codex-toggle.test.ts
bun test tests/server/server-management-auth.test.ts
```

From `gui/`:

```bash
bun test tests/integrations-overview-rows.test.ts
bun test tests/overview-state-merge.test.ts
bun test tests/integrations-surfaces.test.tsx
bun run lint:i18n
bun run build
```

No repository-wide suite.

Security review is required: `src/AGENTS.md` explicitly classifies management API changes as security-boundary changes; [MAINTAINERS.md:59](/Users/jun/.codex/worktrees/ef41/opencodex/MAINTAINERS.md:59) requires explicit review. This patch changes path reporting, not credentials or authorization. Preserve auth gates; keep screenshot paths synthetic.

**NEW asset if carrying:** the PR’s `docs/pr-assets/3407-codex-disable-dialog.png`, or fresh equivalent. [.github/PULL_REQUEST_TEMPLATE.md:8](/Users/jun/.codex/worktrees/ef41/opencodex/.github/PULL_REQUEST_TEMPLATE.md:8) requires a GUI screenshot **in the description**. #3407 already embeds one, but a carry should refresh it against the carried UI. Preserve Summary, Verification, Checklist, `Closes #3406`, and coauthor trailer.

## 4) OPEN QUESTIONS / RESIDUAL UNCERTAINTY

- Conflict analysis is source comparison, not a trial merge; exact unresolved merge hunks were not generated.
- PR test claims and screenshot are author evidence, not fresh verification.
- `getCodexHome()` re-resolves environment and can throw for an invalid directory; retain valid-directory fixtures and assess malformed-home behavior during security review.
- Parent must refresh its baseline before implementation; the stated `HEAD == origin/dev` no longer holds.


