# Phase 1 — Gemini 3.6 catalog, wire compatibility, and verification

## Outcome

One implementation slice adds Gemini 3.6 to the direct Google provider, replaces visible Gemini 3.5 Antigravity tiers with 3.6 tiers, preserves old Antigravity selections through hidden aliases, wires direct Google effort selection, and closes metadata/price/test/runtime parity.

## Change manifest

| Path | Action | Purpose |
|---|---|---|
| `src/providers/antigravity-models.ts` | MODIFY | Separate visible 3.6 rows from hidden 3.5 compatibility aliases. |
| `src/providers/registry.ts` | MODIFY | Add direct Google 3.6 metadata and move the Antigravity default to 3.6 Medium. |
| `src/adapters/google.ts` | MODIFY | Send direct Google 3.5/3.6 reasoning selection as `thinkingLevel`. |
| `src/usage/expected-prices.ts` | MODIFY | Add 3.6 prices and remap hidden old-ID compatibility price aliases to 3.6. |
| `tests/google-antigravity-wire.test.ts` | MODIFY | Prove visible rows, hidden compatibility aliases, and wire resolution. |
| `tests/google-hardening.test.ts` | MODIFY | Prove direct Google 3.6 registry metadata and thinking-level activation. |
| `tests/google-models-listing.test.ts` | MODIFY | Update the static-fallback contract to include direct 3.6. |
| `tests/provider-registry-parity.test.ts` | MODIFY | Prove OAuth projection exposes 3.6 and hides 3.5. |
| `tests/provider-quota.test.ts` | MODIFY | Refresh the Antigravity quota fixture to a current 3.6 row. |
| `tests/usage-cost.test.ts` | MODIFY | Prove 3.6 overlay membership and hidden old-ID compatibility pricing. |
| `tests/codex-catalog.test.ts` | MODIFY | Prove the exact Codex-facing reasoning ladder for direct Google 3.6. |
| `tests/oauth-provider-reconcile.test.ts` | NEW | Prove an existing 3.5 Antigravity preset heals to the 3.6 list/default without credential changes. |

`src/generated/jawcode-model-metadata.ts`, Cursor files/tests, OrcaRouter seed rows, benchmark fixtures, and Vertex configuration are explicitly unchanged.

## 1. Antigravity model owner

### `src/providers/antigravity-models.ts`

Replace the visible Flash wire rows:

```diff
-  "gemini-3.5-flash-low",
-  "gemini-3-flash-agent",
-  "gemini-3.5-flash-extra-low",
+  "gemini-3.6-flash-low",
+  "gemini-3.6-flash-medium",
+  "gemini-3.6-flash-high",
```

Split aliases by responsibility:

- Visible aliases remain only for user-facing names that are still intentional, currently `gemini-3.1-pro-high` and `gemini-3.1-pro-preview` -> `gemini-pro-agent`.
- Hidden compatibility aliases map the five retired 3.5/legacy IDs to the explicit 3.6 tiers fixed in `000_plan.md`.
- `ANTIGRAVITY_MODEL_ALIASES` combines visible and compatibility aliases for request resolution.
- `ANTIGRAVITY_MODELS` combines wire models with visible alias keys only. Compatibility keys must not re-enter the picker.

Replace the three Flash context-window owners with the explicit 3.6 IDs, all 1,048,576. Continue deriving alias context windows from the combined alias map so old saved IDs remain known to routing without becoming visible.

Do not add `gemini-3.6-flash-tiered` to `ANTIGRAVITY_MODELS` or alias it speculatively.

## 2. Registry contracts

### `src/providers/registry.ts` — direct `google`

Keep `defaultModel: "gemini-3.5-flash"` and change the static order to:

```ts
models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview"]
```

Add:

```ts
modelContextWindows: {
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.5-flash": 1_000_000,
},
modelInputModalities: {
  "gemini-3.6-flash": ["text", "image"],
},
modelReasoningEfforts: {
  "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.1-pro-preview": ["low", "medium", "high"],
},
```

The repository's Codex catalog sanitizer exposes low/medium/high; `minimal` remains available to non-Codex CLI/API consumers consistently with the existing 3.5 contract.

### `src/providers/registry.ts` — `google-antigravity`

Change only the default from `gemini-3.5-flash-low` to `gemini-3.6-flash-medium`. The model and context arrays continue to come from the Antigravity owner.

## 3. Direct Google thinking-level wire

### `src/adapters/google.ts`

Import `mapReasoningEffort` from `src/reasoning-effort.ts`. After the existing generation-config fields are assembled, map `parsed.options.reasoning` only for direct AI Studio Gemini 3.5/3.6 requests and emit:

```ts
generationConfig.thinkingConfig = { thinkingLevel };
```

Boundary rules:

- Apply only when `provider.googleMode` is neither `vertex` nor `cloud-code-assist` and the model ID is `gemini-3.5-flash` or `gemini-3.6-flash`.
- Omit `thinkingConfig` when no effort is selected.
- Do not send an extra thinking level to Antigravity; its Low/Medium/High wire model IDs already encode the choice.
- Do not alter temperature/top-p behavior in this slice.

Activation proof is mandatory: the focused adapter test must inspect the built JSON body for a selected `high` level and for omission when unset.

## 4. Price ownership

### `src/usage/expected-prices.ts`

Add:

```ts
const GEMINI_36_FLASH: Cost4 = {
  input: 1.5,
  output: 7.5,
  cacheRead: 0.15,
  cacheWrite: 0,
};
```

Update the Google pricing evidence date to 2026-07-22. Add one `verified` row for `google/gemini-3.6-flash` and three `verified-derived` rows for the Antigravity low/medium/high IDs. Keep the five 3.5/legacy Antigravity rows as hidden compatibility price aliases, but replace their old 3.5/3.0 price constants and evidence with the mapped 3.6 tier's price and an explicit compatibility source string. These rows do not affect picker visibility; they preserve exact-key usage pricing for old saved requests because `resolveMatchedPrice` does not consult the Antigravity wire resolver.

Do not create a `tiered` price row while the model remains hidden. Do not modify the generated jawcode file.

## 5. Test changes

### `tests/google-antigravity-wire.test.ts`

- Assert `ANTIGRAVITY_MODELS` contains all three 3.6 visible tiers.
- Assert it excludes every retired 3.5/legacy Flash ID and `gemini-3.6-flash-tiered`.
- Assert fresh 3.6 IDs pass through unchanged.
- Assert every hidden old ID resolves to its fixed 3.6 target.
- Preserve existing 3.1 Pro alias assertions.

### `tests/google-hardening.test.ts`

- Update direct Google registry expectations to include 3.6 first while keeping 3.5 as default.
- Assert exact 3.6 context, image input, and effort metadata.
- Build a 3.6 direct request with `reasoning: "high"` and assert `thinkingConfig.thinkingLevel`.
- Build without reasoning and assert `thinkingConfig` is absent.

### `tests/google-models-listing.test.ts`

Update the malformed-live-response/static-fallback expected IDs to include `gemini-3.6-flash` in sorted order. Keep the negative assertions that unconfigured `gemini-3-pro` and `gemini-3-flash` do not leak into the fallback.

### `tests/provider-registry-parity.test.ts`

Replace visible Antigravity 3.5 assertions with all three 3.6 IDs, exact 1,048,576 context, and absence of old visible IDs. Preserve the 3.1 Pro checks.

### `tests/provider-quota.test.ts`

Replace the stale fixture's `gemini-3.5-flash-low` row/display name with `gemini-3.6-flash-medium` / “Gemini 3.6 Flash (Medium)”. Quota family classification and redaction assertions remain unchanged.

### `tests/usage-cost.test.ts`

Update the exact overlay count after the source edit, require `google/gemini-3.6-flash`, all three visible Antigravity 3.6 keys, and all five hidden compatibility keys. Add value assertions for 1.5 / 7.5 / 0.15 / 0 and assert compatibility rows now cite 3.6 and remain `verified-derived`.

### `tests/codex-catalog.test.ts`

Build the routed catalog from the canonical direct Google registry config and assert `google/gemini-3.6-flash` exposes exactly the repository-standard Codex ladder `low`, `medium`, `high`, `max`, `ultra`. This closes the audit concern that registry `minimal` can travel through different catalog construction paths: `minimal` is normalized to Codex `low`, while the common catalog layer appends mock `max`/`ultra` tiers and the adapter's configured-effort clamp maps either back to the real wire maximum `high`.

### `tests/oauth-provider-reconcile.test.ts` (NEW)

Use an isolated config path and a synthetic OAuth provider object containing the old 3.5 list/default plus a sentinel OAuth key/project and unrelated user-owned field. Call `reconcileOAuthProviders`, then assert:

- models exactly match the new registry-managed Antigravity list;
- old default heals to `gemini-3.6-flash-medium`;
- context metadata refreshes;
- credential/project and unrelated field are unchanged;
- a second call is idempotent and reports no change.

## 6. Verification sequence

Run from the repository root:

```bash
bun test --isolate \
  tests/google-antigravity-wire.test.ts \
  tests/google-hardening.test.ts \
  tests/google-models-listing.test.ts \
  tests/provider-registry-parity.test.ts \
  tests/provider-quota.test.ts \
  tests/usage-cost.test.ts \
  tests/codex-catalog.test.ts \
  tests/oauth-provider-reconcile.test.ts

bun run typecheck
```

Then verify the built/runtime surface:

```bash
bun src/cli/index.ts models --provider google-antigravity --json
ocx restart
ocx provider show google-antigravity --json
ocx models --provider google-antigravity --json
```

Expected catalog state: default 3.6 Medium; visible Flash rows are exactly Low, Medium, High; no 3.5 Flash or `gemini-3-flash-agent` row.

Finally send one minimal prompt through each route:

```text
google-antigravity/gemini-3.6-flash-low
google-antigravity/gemini-3.6-flash-medium
google-antigravity/gemini-3.6-flash-high
```

Record model, HTTP/stream completion status, and a redacted output tail in this unit. Never persist OAuth tokens, project IDs, or raw `fetchAvailableModels` payloads.

The pre-build baseline already completed this matrix successfully with HTTP 200 for Low, Medium, and High. Repeat the same sanitized matrix after restart so the C gate proves the changed catalog and compatibility code did not regress wire execution.

## 7. Completion and SoT sync

- Append focused-test, typecheck, restart, discovery, and live-inference evidence to `000_plan.md` during C/D.
- Runtime model truth remains `src/providers/registry.ts` plus `src/providers/antigravity-models.ts`; no general README currently enumerates model IDs, so no README edit is needed.
- If jawcode gains an official 3.6 row later, refresh `src/generated/jawcode-model-metadata.ts` mechanically in a separate unit rather than mixing an external snapshot change into this rollout.
- Move the folder to `devlog/_fin/260722_gemini_36_rollout/` only after implementation and verification are complete.
- Commit the completed branch, then integrate it into `/Users/jun/Developer/new/700_projects/opencodex` on local `dev` with a normal `git merge --no-ff gemini-3.6`. Preserve the unrelated dirty issue-sweep devlog file exactly by comparing its pre/post content hash; verify the merge commit contains the Gemini tip and rerun the focused smoke test from `dev`. Do not push.
- After all merged-`dev` checks pass, run `git worktree remove /Users/jun/.codex/worktrees/2d67/opencodex` from the main repository. Do not delete the merged branch ref and do not force cleanup over a dirty Gemini worktree.
