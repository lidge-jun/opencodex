# Routed Computer Use and Browser Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Make every non-OpenAI model exposed through the opencodex Codex catalog use Codex's official code-mode executor so Computer Use and Browser remain callable, while preserving native OpenAI metadata and the existing vision, image-generation, and DeepSeek streaming fixes.

**Architecture:** Add one explicit routed-catalog compatibility policy, `tool_mode: "code_mode_only"`, at the common normalization boundary. Apply the same policy to the no-template fallback path. Do not add local UI executors to opencodex; the proxy continues translating Codex's `exec` custom tool into ordinary provider function calling and relaying `custom_tool_call` events back to Codex.

**Tech Stack:** TypeScript, Bun, `bun:test`, Codex model catalog JSON, opencodex Responses adapters, launchd background service.

---

## Task 1: Lock the routed catalog contract with failing tests

**Files:**
- Modify: `tests/codex-catalog.test.ts:280-300`
- Modify: `tests/codex-catalog.test.ts:1011-1045`
- Modify: `tests/codex-catalog.test.ts:1230-1255`

**Step 1: Change the combo assertion to require the explicit routed mode**

Replace the old omission assertion with:

```ts
expect(row.tool_mode).toBe("code_mode_only");
```

This covers bare and slashed combo aliases.

**Step 2: Change direct normalization and template-derived routed assertions**

Use these expectations:

```ts
expect(entry.tool_mode).toBe("code_mode_only");
expect(routed?.tool_mode).toBe("code_mode_only");
```

Keep the existing assertions that native-only selectors such as `model_messages`, `use_responses_lite`, and inherited service tiers are removed.

**Step 3: Add a fallback-row test**

Add:

```ts
test("buildCatalogEntries assigns code-only tools to routed fallback rows", () => {
  const rows = buildCatalogEntries(null, [], [
    { provider: "deepseek", id: "deepseek-v4-flash", owned_by: "deepseek" },
  ]);

  const routed = rows.find(row => row.slug === "deepseek/deepseek-v4-flash");
  expect(routed?.tool_mode).toBe("code_mode_only");
});
```

**Step 4: Strengthen native and account-qualified preservation**

Keep the native `tool_mode: "code"` assertion and add an account selector fixture:

```ts
const rows = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [], undefined, false, "default", new Set(), ["team"]);
expect(rows.find(row => row.slug === "gpt-5.5")?.tool_mode).toBe("code");
expect(rows.find(row => row.slug === "team/gpt-5.5")?.tool_mode).toBe("code");
```

**Step 5: Run the focused tests and confirm RED**

Run:

```bash
bun test tests/codex-catalog.test.ts
```

Expected: routed/template/combo/fallback assertions fail because current production code deletes or omits `tool_mode`; native preservation assertions remain green.

**Step 6: Commit the red tests only**

```bash
git add tests/codex-catalog.test.ts
git commit -m "test(codex): require code mode for routed models"
```

## Task 2: Implement the minimal catalog policy

**Files:**
- Modify: `src/codex/catalog/parsing.ts:341-375`
- Modify: `src/codex/catalog/sync.ts:33`
- Modify: `src/codex/catalog/sync.ts:276-310`
- Test: `tests/codex-catalog.test.ts`

**Step 1: Add a named compatibility helper**

In `src/codex/catalog/parsing.ts`, add:

```ts
export const ROUTED_CODEX_TOOL_MODE = "code_mode_only";

export function applyRoutedCodexToolMode(entry: RawEntry): RawEntry {
  entry.tool_mode = ROUTED_CODEX_TOOL_MODE;
  return entry;
}
```

**Step 2: Make routed normalization explicit rather than inherited**

Retain the deletion of the native template's selector, then apply the deliberate compatibility policy:

```ts
delete entry.tool_mode;
applyRoutedCodexToolMode(entry);
```

This prevents accidental native-template inheritance while producing a stable routed value.

**Step 3: Apply the same policy to no-template fallback rows**

Import `applyRoutedCodexToolMode` in `src/codex/catalog/sync.ts`, then call it in the `isRouted` fallback branch before strict-field normalization:

```ts
if (isRouted) {
  applyRoutedCodexToolMode(entry);
  applyReasoningLevels(/* existing arguments */);
}
```

Do not call the full routed normalizer from the fallback branch; that would broaden behavior by changing unrelated search and parallel-tool metadata.

**Step 4: Run the focused tests and confirm GREEN**

```bash
bun test tests/codex-catalog.test.ts
```

Expected: all catalog tests pass, including native/account preservation.

**Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: exit 0.

**Step 6: Commit production code**

```bash
git add src/codex/catalog/parsing.ts src/codex/catalog/sync.ts
git commit -m "fix(codex): enable code mode for routed models"
```

## Task 3: Prove on-disk catalog synchronization preserves the policy

**Files:**
- Modify: `tests/codex-catalog-sync-hardening.test.ts`
- Test: `tests/codex-catalog-sync-hardening.test.ts`

**Step 1: Add a real sync fixture assertion**

Add a focused test that writes a native template with `tool_mode: "code"`, configures one selected DeepSeek model, runs `syncCatalogModels`, and reads the persisted catalog. Assert:

```ts
expect(rows.find(row => row.slug === "deepseek/deepseek-v4-flash")?.tool_mode)
  .toBe("code_mode_only");
expect(rows.find(row => row.slug === "gpt-5.5")?.tool_mode).toBe("code");
```

Also assert a generated native account-qualified row retains `"code"` if the fixture enables an account namespace.

**Step 2: Run the sync test**

```bash
bun test tests/codex-catalog-sync-hardening.test.ts
```

Expected: pass and prove the serialized catalog, not merely the in-memory builder.

**Step 3: Commit the persistence test**

```bash
git add tests/codex-catalog-sync-hardening.test.ts
git commit -m "test(codex): persist routed code mode policy"
```

## Task 4: Document the host-tool contract

**Files:**
- Modify: `docs-site/src/content/docs/guides/codex-integration.md:170-230`

**Step 1: Document routed tool mode near the shared catalog section**

Add a concise subsection explaining:

```md
### Routed local tools

Non-OpenAI catalog rows use `tool_mode: "code_mode_only"`. This lets Codex expose
its official `exec` entrypoint and nested MCP tools, including Browser and Computer
Use, while opencodex routes only the model's ordinary function call. Tool execution,
permissions, and confirmation remain local to Codex. Providers without function-call
support cannot use these tools. Native OpenAI rows keep their upstream tool mode.
```

Mention that Codex App must be restarted and a fresh task opened after catalog synchronization.

**Step 2: Build the documentation site**

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

Expected: build succeeds with no broken content links.

**Step 3: Commit documentation**

```bash
git add docs-site/src/content/docs/guides/codex-integration.md
git commit -m "docs(codex): explain routed local tool access"
```

## Task 5: Run the five-capability regression matrix

**Files:**
- Verify only: existing sources and tests

**Step 1: Verify custom/freeform `exec` protocol coverage**

Run:

```bash
bun test tests/responses-parser.test.ts tests/bridge.test.ts tests/multi-agent-compat.test.ts
```

Expected: custom declaration, streaming `custom_tool_call`, exact freeform input, and output replay remain green. Add no production protocol change unless one of these tests proves a real gap.

**Step 2: Verify DeepSeek Responses streaming and cancellation**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts tests/deepseek-inbound-wire.test.ts tests/deepseek-responses-item-id-repair.test.ts tests/passthrough-abort.test.ts
```

Expected: progressive deltas, strict terminal repair, item IDs, and cancellation pass.

**Step 3: Verify Responses vision**

Run:

```bash
bun test tests/vision-sidecar-e2e.test.ts tests/vision-anthropic.test.ts tests/vision-cache.test.ts tests/vision-fail-closed.test.ts tests/catalog-vision-sidecar-modalities.test.ts tests/openai-responses-passthrough.test.ts
```

Expected: captions replace raw image parts in passthrough bodies, empty references do not consume captions, and partial/failure paths omit pixels safely.

**Step 4: Verify image generation**

Run:

```bash
bun test tests/images/plan.test.ts tests/images/synthetic-tool.test.ts tests/images/z-handler-activation.test.ts tests/images/loop-reasoning-replay.test.ts tests/responses-image-gen-repair.test.ts
```

Expected: image tool planning, activation, alias restoration, replay, and result repair pass.

**Step 5: Run repository gates**

Run:

```bash
bun run typecheck
bun run privacy:scan
bun run test
```

Because this worktree contains pre-existing untracked duplicate `* 2.*` files, if the full-suite source inventory fails only on those files, reproduce the suite from a clean temporary checkout at the same commit and document both results. Do not delete or add the user's duplicate files.

**Step 6: Record any verification-only outcome**

No commit is needed unless a failing regression requires a scoped test or production correction. Any such correction must repeat RED -> GREEN and use its own exact-file commit.

## Task 6: Back up and deploy the validated local build

**Files:**
- Back up: `~/.opencodex/config.json`
- Back up: `~/.codex/config.toml`
- Back up: `~/.codex/opencodex-catalog.json`
- Back up: `~/Library/LaunchAgents/com.opencodex.proxy.plist`
- Replace: installed `@bitkyc08/opencodex` package/runtime

**Step 1: Capture provenance and create a timestamped backup**

Record the installed `ocx` path/version, service PID/runtime path, current git SHA, and SHA-256 hashes of the four configuration/service files. Copy present files into one timestamped directory under `/private/tmp` without printing credentials.

**Step 2: Build a local package artifact**

Run the repository packaging script and create an npm-compatible tarball from the validated commit. Inspect its file list to confirm the package contains the changed catalog source and existing DeepSeek/vision/image code.

**Step 3: Install the exact artifact and repair the service**

Install the local artifact into the same global prefix that owns the current `ocx`, then run:

```bash
ocx service repair
ocx sync
ocx status
```

Expected: the launchd service is loaded, the installed runtime provenance points to the new package, port `10100` serves `/healthz`, and sync rewrites catalog/cache successfully.

**Step 4: Inspect generated metadata without exposing secrets**

Read `~/.codex/opencodex-catalog.json` and `~/.codex/models_cache.json`. Assert:

- `deepseek/deepseek-v4-flash.tool_mode === "code_mode_only"`
- native GPT-5.6 rows retain their upstream mode
- routed model list still includes DeepSeek

## Task 7: Run fresh Codex end-to-end acceptance

**Files:**
- Verify only: installed runtime and fresh Codex tasks

**Step 1: Validate Computer Use through the default routed model**

Start a fresh Codex CLI task without a model or reasoning override. Ask it to load the official Computer Use skill and call `sky.list_apps()` read-only through `mcp__node_repl__js`.

Expected: a real app count returns; the model does not fall back to searching for a shell executable.

**Step 2: Validate Browser through the default routed model**

Start another fresh task and ask it to load the official Browser skill, connect to the default browser, and report the browser name without navigation or clicks.

Expected: it identifies the Codex in-app browser through the nested browser client.

**Step 3: Validate progressive DeepSeek output**

Use a fresh text-only task and inspect proxy request logs. Expected: multiple progressive SSE events arrive before exactly one valid terminal; no `502`, stall, or premature disconnect.

**Step 4: Validate vision and image generation**

Use separate fresh tasks. Attach a known test image and request a factual description; then request a small generated test image. Verify the first reaches the text-only model as a caption without raw pixels and the second returns a renderable image through the configured image backend.

**Step 5: Validate native OpenAI remains available**

After the user restarts Codex App, select one native GPT-5.6 model in a fresh task and confirm its Computer Use/Browser behavior is unchanged.

**Step 6: Final handoff**

Report the exact installed commit, artifact/provenance, service status, catalog values, focused/full-suite results, and each real acceptance result. If Codex App itself cannot be restarted without terminating this task, explicitly ask the user to restart it once; CLI and service evidence must already be complete.
