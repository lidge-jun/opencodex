# 050 — Preserve Fable 1M picker selection (source PR #3649)

Status: implementation plan only; no implementation or runtime validation performed.
Anchored 2026-09-06 to checkout `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`.
All paths below are repository-relative. Main owns 000, the goalplan, integration, and phase transitions.

## Loop specification

- Class: C3 catalog-to-ingress contract; the native passthrough portion requires explicit security review under MAINTAINERS.md:57-71. This research task is docs-only.
- Archetype: spec-satisfaction repair; one later PABCD cycle for this entire numbered plan.
- Trigger: Fable base and marked canonical selectors collapse into one client picker family (public source-PR report).
- Goal: retain independently selectable canonical Fable and 1M rows while forwarding canonical Fable on Messages/count_tokens.
- Non-goals: other Anthropic families, model-cap changes, generalized alias rewrite, Desktop registry repair (#3646), auth-policy changes, GUI component work, release operations.
- Verifier: exact-head hosted Cross-platform CI with actual Linux/macOS tests and gates; client picker evidence is a separate required artifact, not inferred from a unit test.
- Stop: all acceptance rows below have evidence, source contribution survives carry/squash, and main proves the carry is on dev before closing #3649. DONE is not available from this document alone.
- Memory artifact: this document plus main's 000 index and scratch review `.tmp/lane-b/plan-fable-review.md`.
- Bounds for this delegated research: local read-only source/metadata, two permitted documentation writes, no credentials or paid provider requests, no recursive workers needed; finish one bounded research pass. The consuming implementation inherits 000_plan.md: no numeric token/cost cap, six-hour work-phase checkpoint; restate this at the consuming P.
- Escalation: return concrete blockers to main; downstream delegation requires a P amendment; main reclaims a packet after two distinct workers fail it.
- Terminal meanings: DONE = later verified landing; NOOP = fresh dev already supplies the exact behavior/tests; BLOCKED = missing external CI/client evidence; UNSAFE/NEEDS_HUMAN = unresolved review decision; resource bounds never imply DONE.

## Source and attribution

Public source: https://github.com/lidge-jun/opencodex/pull/3649

- Source base: `45f3bed84be10a7e045a20aae1db46ab822bf7d0`.
- Source head: `95becce94255982667cef10308806770d49cc05b`.
- Behavior commit: `9a7795aa34df219654512366040d87a219fb4ada` (`fix(gateway): preserve Fable 1M picker selection`).
- Follow-up regression: `284fe8ca0b793d51c6cdd609f1c9acf219f2eaf9` (`test(gateway): cover marked Fable picker alias`).
- Head is a merge of `284fe8ca0` and `45f3bed84`; do not cherry-pick that merge as a third implementation change.
- Actual Git author AND committer of all three: `Éverton Toffanetto <evertondgn@hotmail.com>` (`everton-dgn`). Verified with `git show -s --format=fuller` against locally available commit objects, corroborated by the supplied JSON commit list.
- Any squash or rewritten carry must include `Co-authored-by: Éverton Toffanetto <evertondgn@hotmail.com>`. Preserve original authors on cherry-picked commits; attribution in prose alone is insufficient.
- Input evidence: `.tmp/lane-b/3649.json` and `.tmp/lane-b/3649.patch`. JSON reports OPEN/MERGEABLE; this is a supplied snapshot, not a new live readiness claim. It contains no successful hosted CI evidence.

## Current owners and activation path

1. `src/server/index.ts:1479-1516` serves Anthropic discovery and calls `buildAnthropicModelInfos`. `?ids=cli` or a `claude-code/` UA selects readable IDs; explicit desktop/unknown UA retains Desktop IDs. Native registry setup remains untouched.
2. `src/claude/model-info.ts:146-165` owns 1M row generation. It requires authoritative context >= 1M, rejects already-marked IDs, deduplicates, and caps advertised input at min(1M, maxInputTokens).
3. `src/claude/model-info.ts:196-227` owns routed row emission; `listedModelId` already reflects the Cursor Fast exception. Put the Fable condition here, not in the generic alias encoder.
4. `src/claude/alias.ts:141-148` leaves canonical Anthropic IDs bare and exposes reversible native aliases. `resolveAlias` at :112-128 returns bare slugs for the native pseudo-provider. Reuse these functions without changing their public exports.
5. `src/claude/inbound-model-options.ts:39-68` resolves aliases before modelMap. `src/claude/inbound.ts` exports the resolver used by the server. Preserve that order.
6. `src/server/claude-messages.ts:634-668` strips `[1m]`, honors ocx-route, then parses Fast/effort. Insert the narrowly scoped Fable restoration between route override and synthetic-row parsing. `wantsNativePassthrough` at :151-168 subsequently examines the canonical model.
7. `src/server/claude-messages.ts:1069-1096` has the corresponding count_tokens path; insert restoration after countRoute and before Fast-only normalization.

No configuration-only remedy repairs the emitted selector identity. No-op is ruled out by the current generic `${base.id}[1m]` at model-info.ts:153 and the absent helper/call sites. Reuse wins over a new registry, provider, flag, or global decoder.

## Exact change map for the later implementation cycle

| Operation | Path | Change |
|---|---|---|
| MODIFY | `src/claude/model-info.ts` | Optional selectorId in local push1mVariant; readable canonical Anthropic Fable-only 1M alias |
| MODIFY | `src/server/claude-messages.ts` | Import existing encoder; private Fable decoder; two ingress call sites |
| MODIFY | `tests/claude-integration/claude-model-info.test.ts` | Source positive test plus Fable-specific style/window regressions below |
| MODIFY | `tests/claude-integration/claude-native-passthrough.test.ts` | Source three-request regression plus canonical legacy/marker compatibility assertions |
| MODIFY | `docs-site/src/content/docs/guides/claude-code.md` | Explain the bounded Fable 1M exception in both canonical-ID statements |
| NEW | none (production/tests) | Existing owners and registered tests suffice |

This research writes only this numbered document and the delegated scratch report. No schema/layout manifest update is needed: both test basenames already exist in `scripts/test-layout/layout.json:296-298` and `tests/fixtures/test-layout-expected.json:133-135`.

## Focused source patch to carry

Use the complete public four-file patch below. It includes the follow-up marked Messages case; carrying only the first commit drops that regression. Context line numbers belong to the source patch; match current owners above and refresh at P.

```diff
diff --git a/src/claude/model-info.ts b/src/claude/model-info.ts
index cbecf8c60a..bcd047a281 100644
--- a/src/claude/model-info.ts
+++ b/src/claude/model-info.ts
@@ -143,14 +143,19 @@ export function buildAnthropicModelInfos(
   // the auto-context widening that let a 372K route carry the marker (and be
   // over-filled) is the #854 defect and does not come back. Guards (audit R1#11):
   // same dedupe set, never double-suffix.
-  const push1mVariant = (base: AnthropicModelInfo, contextWindow: number | undefined, maxInputTokens?: number) => {
+  const push1mVariant = (
+    base: AnthropicModelInfo,
+    contextWindow: number | undefined,
+    maxInputTokens?: number,
+    selectorId?: string,
+  ) => {
     // The [1m] marker makes Claude Code account 1e6 tokens for the row, so it
     // may only name models whose AUTHORITATIVE effective window is >= 1M —
     // never the auto-context widening, which would mark a 372K route and have
     // Claude Code over-fill it (the #854 defect).
     if (contextWindow === undefined || contextWindow < ONE_MILLION) return;
     if (base.id.includes("[1m]")) return;
-    const id = `${base.id}[1m]`;
+    const id = selectorId ?? `${base.id}[1m]`;
     if (seen.has(id)) return;
     seen.add(id);
     // The marker fixes Claude Code's accounting at 1e6, but a model may accept less input
@@ -220,7 +225,15 @@ export function buildAnthropicModelInfos(
     out.push(info);
     // Anthropic passthrough guard (audit 021 #3): never auto-widen canonical claude
     // routes — only a genuine >=1M window earns the variant row there.
-    push1mVariant(info, m.contextWindow, routedMaxInput);
+    // Claude Code groups canonical Fable ids before it compares the [1m] marker. This
+    // reversible alias only separates picker families; it is not an OpenAI-native route.
+    // The Messages ingress restores the canonical Anthropic id before passthrough.
+    const oneMillionSelector = idStyle === "readable"
+      && m.provider === "anthropic"
+      && listedModelId.startsWith("claude-fable-")
+      ? `${claudeCodeNativeAlias(listedModelId)}[1m]`
+      : undefined;
+    push1mVariant(info, m.contextWindow, routedMaxInput, oneMillionSelector);
     // The whole model is passed, not a (provider, id) pair: a combo row lives in its own
     // namespace with no config.providers entry, so the caller classifies it from the
     // aggregated supportsServiceTier the row already carries.
diff --git a/src/server/claude-messages.ts b/src/server/claude-messages.ts
index 70572f9c67..d2eedfa4ab 100644
--- a/src/server/claude-messages.ts
+++ b/src/server/claude-messages.ts
@@ -12,6 +12,7 @@ import { enforceAnthropicImageLimits, sniffImageDimensions } from "../adapters/a
 import { normalizeAnthropicImages } from "../adapters/anthropic-image-normalize";
 import { AnthropicRequestError, anthropicToResponsesTranslation, extractOcxEffortDirective, extractOcxRouteDirective, resolveInboundModel, type ClaudeCacheKeySource } from "../claude/inbound";
 import { resolveDesktop3pAlias } from "../claude/desktop-3p";
+import { claudeCodeNativeAlias } from "../claude/alias";
 import { recordDesktopRequest } from "../claude/desktop-health";
 import { stripOneMillionMarker } from "../claude/context-windows";
 import { captureClaudeInbound } from "../claude/inbound-debug";
@@ -78,6 +79,13 @@ function decodeClaudeFastSelector(raw: string, cc?: OcxConfig["claudeCode"]): st
   return decodedBase === bare ? exact : `${decodedBase}--fast`;
 }
 
+/** Restore the reversible Fable picker alias before Anthropic passthrough checks. */
+function decodeFablePickerAlias(raw: string, cc?: OcxConfig["claudeCode"]): string {
+  const decoded = resolveInboundModel(raw, cc);
+  if (!decoded.startsWith("claude-fable-")) return raw;
+  return claudeCodeNativeAlias(decoded) === raw ? decoded : raw;
+}
+
 function isRec(v: unknown): v is Rec {
   return !!v && typeof v === "object" && !Array.isArray(v);
 }
@@ -648,6 +656,9 @@ async function handleClaudeMessagesWithBudget(
         effortOverride = extractOcxEffortDirective(anthropicBody);
       }
     }
+    if (isRec(anthropicBody) && typeof anthropicBody.model === "string") {
+      anthropicBody.model = decodeFablePickerAlias(anthropicBody.model, config.claudeCode);
+    }
     if (isRec(anthropicBody) && typeof anthropicBody.model === "string") {
       requestedModel = anthropicBody.model;
       // Decode for Fast only. A Claude alias is `claude-ocx-<provider>--<model>`, so it
@@ -1070,6 +1081,8 @@ export async function handleClaudeCountTokens(
     model = stripOneMillionMarker(countRoute);
     raw.model = model;
   }
+  model = decodeFablePickerAlias(model, config.claudeCode);
+  raw.model = model;
   // Fast-only: count_tokens never parsed an effort row, so it must not start. It returns a
   // token estimate and sends no tier, so only the IDENTITY is corrected - without this the
   // synthetic id reaches native passthrough as a model Anthropic has never heard of.
diff --git a/tests/claude-integration/claude-model-info.test.ts b/tests/claude-integration/claude-model-info.test.ts
index 0a2d151a1b..b9a23342af 100644
--- a/tests/claude-integration/claude-model-info.test.ts
+++ b/tests/claude-integration/claude-model-info.test.ts
@@ -44,6 +44,22 @@ describe("anthropic-flavor ModelInfo discovery entries (devlog 130 B4b)", () =>
     expect(info!.capabilities.effort.max.supported).toBe(true);
   });
 
+  test("readable Fable rows keep base and 1M selections distinct in Claude Code", () => {
+    const infos = buildAnthropicModelInfos([], [{
+      provider: "anthropic",
+      id: "claude-fable-5-1",
+      contextWindow: 1_000_000,
+      maxInputTokens: 1_000_000,
+    }], undefined, "readable");
+
+    expect(infos.map(info => info.id)).toEqual([
+      "claude-fable-5-1",
+      "claude-ocx-native--claude-fable-5-1[1m]",
+    ]);
+    expect(infos[1]!.display_name).toBe("claude-fable-5-1 (anthropic) · 1M");
+    expect(infos[1]!.max_input_tokens).toBe(1_000_000);
+  });
+
   test("native effective ladder only advertises clamp-identity rungs (audit R4#1)", () => {
     for (const slug of ["gpt-5.5", "gpt-5.4", "gpt-5.6-sol"]) {
       for (const rung of nativeEffectiveLadder(slug)) {
diff --git a/tests/claude-integration/claude-native-passthrough.test.ts b/tests/claude-integration/claude-native-passthrough.test.ts
index c8c798ac9a..af87aa83cb 100644
--- a/tests/claude-integration/claude-native-passthrough.test.ts
+++ b/tests/claude-integration/claude-native-passthrough.test.ts
@@ -206,6 +206,47 @@ test("count_tokens passes through with native credentials", async () => {
   }
 });
 
+test("Fable 1M picker alias preserves native passthrough on both Messages endpoints", async () => {
+  const captured: Captured[] = [];
+  const upstream = mockAnthropicUpstream(captured);
+  saveConfig(cfg(upstream.url.toString().replace(/\/$/, "")));
+  const server = startServer(0);
+  const pickerModel = "claude-ocx-native--claude-fable-5-1";
+  try {
+    const messagesWithoutMarker = await fetch(new URL("/v1/messages", server.url), {
+      method: "POST",
+      headers: OAUTH_HEADERS,
+      body: JSON.stringify({ ...claudeBody(), model: pickerModel }),
+    });
+    expect(messagesWithoutMarker.status).toBe(200);
+    await messagesWithoutMarker.text();
+
+    const messagesWithMarker = await fetch(new URL("/v1/messages", server.url), {
+      method: "POST",
+      headers: OAUTH_HEADERS,
+      body: JSON.stringify({ ...claudeBody(), model: `${pickerModel}[1m]` }),
+    });
+    expect(messagesWithMarker.status).toBe(200);
+    await messagesWithMarker.text();
+
+    const countTokens = await fetch(new URL("/v1/messages/count_tokens", server.url), {
+      method: "POST",
+      headers: OAUTH_HEADERS,
+      body: JSON.stringify({ model: `${pickerModel}[1m]`, messages: [{ role: "user", content: "hi" }] }),
+    });
+    expect(countTokens.status).toBe(200);
+    expect(await countTokens.json()).toEqual({ input_tokens: 4242 });
+
+    expect(captured).toHaveLength(3);
+    expect(captured[0]!.body.model).toBe("claude-fable-5-1");
+    expect(captured[1]!.body.model).toBe("claude-fable-5-1");
+    expect(captured[2]!.body.model).toBe("claude-fable-5-1");
+  } finally {
+    await server.stop(true);
+    upstream.stop(true);
+  }
+});
+
 test("exposed native passthrough requires dedicated admission and never forwards admission credentials", async () => {
   const admissionSecret = "sk-ant-api03-key";
   const providerBearer = "sk-ant-oat01-provider";
```

## Additional bounded acceptance edits

In the existing model-info test file, directly after the carried Fable test, add this behavioral matrix (existing imports suffice):

```ts
test("Fable 1M aliases preserve style, window and input-ceiling boundaries", () => {
  const fable = { provider: "anthropic", id: "claude-fable-5-1", contextWindow: 1_000_000, maxInputTokens: 922_000 };
  const readable = buildAnthropicModelInfos([], [fable], undefined, "readable");
  expect(readable[1]!.id).toBe("claude-ocx-native--claude-fable-5-1[1m]");
  expect(readable[1]!.max_input_tokens).toBe(922_000);
  const desktop = buildAnthropicModelInfos([], [fable], undefined, "desktop3p");
  expect(desktop[1]!.id).toBe(`${desktop[0]!.id}[1m]`);
  const smaller = buildAnthropicModelInfos([], [{ ...fable, contextWindow: 200_000 }], undefined, "readable");
  expect(smaller.map(row => row.id)).toEqual(["claude-fable-5-1"]);
  const unknown = buildAnthropicModelInfos([], [{ provider: "anthropic", id: "claude-fable-5-1" }], undefined, "readable");
  expect(unknown.map(row => row.id)).toEqual(["claude-fable-5-1"]);
  const other = buildAnthropicModelInfos([], [{ ...fable, id: "claude-opus-5" }], undefined, "readable");
  expect(other.map(row => row.id)).toEqual(["claude-opus-5", "claude-opus-5[1m]"]);
});
```

Extend the carried native-passthrough test after its first three requests with the following legacy selectors. Adjust captured length from 3 to 6; assert every captured model is canonical. Existing mock upstream and credential fixture are reused.

```ts
for (const model of ["claude-fable-5-1", "claude-fable-5-1[1m]", `${pickerModel}[1M]`]) {
  const response = await fetch(new URL("/v1/messages", server.url), {
    method: "POST", headers: OAUTH_HEADERS,
    body: JSON.stringify({ ...claudeBody(), model }),
  });
  expect(response.status).toBe(200);
  await response.text();
}
expect(captured).toHaveLength(6);
for (const call of captured) {
  expect(call.body.model).toBe("claude-fable-5-1");
  expect(call.headers.get("anthropic-beta")).toBe(OAUTH_HEADERS["anthropic-beta"]);
}
```

The round-trip guard and prefix guard must remain; do not replace them with generic decoding of every alias. Existing alias, mapped-model, disabled-passthrough, and exposed-listener regressions remain required CI coverage. Review-specific additions, if needed, are recorded only in scratch.

## Documentation diff and GUI evidence

The source PR modifies no docs even though its body checks the docs box. Add the bounded exception to the English guide; do not claim all canonical 1M rows are encoded or that base Fable loses its native ID.

```diff
--- a/docs-site/src/content/docs/guides/claude-code.md
+++ b/docs-site/src/content/docs/guides/claude-code.md
@@
-Desktop's third-party gateway mode can offer its effort selector. Real Anthropic models keep their
-canonical ids. The synthetic 2026 date is an internal slot, not a release date. Legacy hash aliases
+Desktop's third-party gateway mode can offer its effort selector. Real Anthropic base rows keep
+their canonical ids. For Claude Code, a canonical Fable model with an authoritative 1M window
+uses `claude-ocx-native--claude-fable-5-1[1m]` for its separate 1M selection. This reversible
+selector distinguishes picker families; Messages and count_tokens restore the canonical Fable
+id before native passthrough. Desktop 3P selectors keep their existing format.
+The synthetic 2026 date is an internal slot, not a release date. Legacy hash aliases
@@
-(reasoning-effort ladder, thinking types) in the official `ModelInfo` shape. Real Anthropic models
-keep their canonical ids on both surfaces.
+(reasoning-effort ladder, thinking types) in the official `ModelInfo` shape. Real Anthropic base
+rows keep their canonical ids; the readable Fable 1M exception is described above.
```

Do not describe the unmarked row as necessarily a 200K upstream model: both rows may advertise a genuine 1M window; the marker controls client accounting. Preserve the existing rule that beta headers, not a model suffix alone, convey provider context semantics.

Translation coordination before readiness: main's documentation owner must inspect `docs-site/src/content/docs/{ko,ja,zh-cn,zh-tw,fr,ru,tr}/guides/claude-code.md` for equivalent unconditional canonical-ID statements and add the same scoped exception where needed. No translation edits are delegated to this research worker; record the final exact locale touch set at consuming P. This is a readiness debt, not permission to leave contradictory translations.

No OCX React component changes are required. Capture client evidence for fresh selection, saved old bare/marked selection, switching Fable→Opus→Fable 1M, settings persistence, and restart. Record Claude Code version, discovery payload, selected ID and resulting upstream model in a sanitized artifact. Screenshots should show both picker rows and retained selection. Do not present source-author harness claims as current reproduced evidence. If the PR description mentions GUI, include its screenshot as required by repository PR policy.

## CI-only verification contract

NO local tests, typecheck, builds, suite helpers or provider probes. Commands below describe CI execution, not commands to execute on the local workstation.

- `.github/workflows/ci.yml:7` triggers on every pull_request base, including stacked children; no dev-only base filter.
- `changes` at :182-187 includes src/tests, so this implementation triggers expensive jobs. A docs-only roadmap CI success can legitimately skip tests and proves no runtime behavior.
- Linux `test` at :255-267 is four shards; :314-316 invokes `bash scripts/ci/run-bun-test-batches.sh "$TEST_SHARD"`.
- The helper at :46-68 excludes only storage-policy/storage/api-usage families, not these tests. At :196-211 it sorts all test files and distributes every eligible file exactly once across shard indices; :122-125 executes `bun test --isolate --timeout 60000` on the selected filenames. Both existing changed test paths are included.
- `gates` at :392-431 runs `bun x tsc --noEmit`, the additional contract tsconfig, GUI tests, and privacy scan. GUI lint is conditional on gui changes; do not mistake that skip for a failure on this backend-only layer.
- macOS at :451-465 runs two shards; :532 invokes `bun test --isolate --timeout 60000 tests --shard=.../2`.
- Windows at :658-686 is **dispatch-only**, lane `all`; :754 invokes six shards. Ordinary PR green is not Windows full-suite evidence. Main decides/dispatches any required exact-head Windows run; this research starts none.
- Focused failure diagnosis target, if a CI runner needs it: `bun test tests/claude-integration/claude-model-info.test.ts tests/claude-integration/claude-native-passthrough.test.ts tests/claude-integration/claude-models-discovery.test.ts tests/claude-integration/claude-alias.test.ts`. Do not add a workflow solely to run this command.
- Save run URL, event, head_sha, checkout/merge SHA, non-skipped job conclusions and test log paths. Resolve fork `action_required` via main's normal approval process; hygiene labels/author checkboxes/old-head approval are not product-test evidence.

| Acceptance | Activation and observable evidence |
|---|---|
| Distinct rows | Readable Anthropic Fable >=1M emits bare base and reversible `[1m]` sibling with honest display name |
| Narrow family/style | Opus retains canonical marker; Desktop retains its prior selector; no other provider is rewritten |
| Capacity guard | 200K or undefined Fable window emits no sibling; 922K input cap under 1M window remains 922K |
| Marker compatibility | New alias with/without marker plus upper-case marker and legacy canonical selectors reach canonical Fable on mock upstream |
| Both endpoints | Messages status/stream consumed; count_tokens returns upstream 4242, not local estimate; captured model canonical |
| Routing coexistence | Existing alias/modelMap/Fast/effort regressions stay green; no global resolver or Desktop registry edit |
| Client persistence | Versioned client evidence demonstrates saved selection after switching and restart, including legacy behavior |
| Gates | All required exact-head CI jobs execute/pass; Windows status reported separately |

## Dependencies, carry and close-out

The four source paths plus English guide have **zero touched-path overlap** with supplied source PRs #3653/#3654/#3571/#3659 (JSON file-list intersection inspected). Fable is independently reviewable: no semantic requirement to land context persistence or Go ordering first. Per 000_plan.md, the user-requested stack uses `codex/lane-b-05-fable` based on `codex/lane-b-04-management`; do not invent a runtime dependency. Discovery still consumes the current predecessor's catalog and limits, so rerun exact-head gates after restack.

Lane D owns #3646 remote Desktop aliases. Coordinate before altering `claude-messages.ts` or decoder ordering; do not carry its unknown-registry fallback into this Fable slice. This plan deliberately changes neither `desktop-3p.ts` nor `inbound-model-options.ts`.

Safe later carry: apply the two non-merge source commits in order on main's selected layer, preserving author metadata, then add the bounded tests/docs as own commits. Do not reset the bound checkout, cherry-pick the source merge parent, or replace other lanes' edits. A lower-layer squash means refresh onto the new dev ancestry and replay only unique Fable commits, then obtain fresh CI/review. Main owns `--no-verify` pushes and bottom-up merges. Retarget children before removing a parent branch. Close source PR #3649 only after proving its replacement commit is in dev, and link the replacement. No linked issue is specified in the source body; do not close #3646 or unrelated issues.

## Unresolved items for main

- Exact-head hosted verification and actual picker compatibility are not established by this research.
- Legacy request forwarding is testable with the additions above; saved client selection migration remains a separate client-level observation.
- The old review's missing marked Messages case is already resolved by `284fe8ca0`; Fable-only scope is explicit in the current source body and comments. Do not repeat these as open code defects.
- Translation touch set must be fixed at P before implementation readiness.
- Relevant security review is tracked only in `.tmp/lane-b/plan-fable-review.md`; this tracked plan contains public source behavior, not unpublished findings.

Roadmap handoff: this document is ready for main's A audit. The unresolved checks above are explicit later B/C acceptance work, not a request to implement during the docs-only cycle. Final landing and closure follow `060_landing.md`.
