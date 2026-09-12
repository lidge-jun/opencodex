# gpt-5.4 / gpt-5.4-mini retirement on the Codex login surface

## Objective

OpenAI retired `gpt-5.4` and `gpt-5.4-mini`. Remove them from the Codex (ChatGPT
OAuth) login surface of this proxy: the native catalog, everything that projects it
(`/v1/models`, the dashboard picker, the desktop projection, Claude discovery), and
every opencodex-owned default that still dispatches one of the two slugs.

The replacement floor is `gpt-5.6-luna` — it is now the cheapest native model on the
ChatGPT login lane, so every helper/sidecar/warmup default lands there. The login
provider's own `defaultModel` moves there too: `gpt-5.6-sol` was considered because it
is priority 1 in the pinned snapshot and `gpt-5.4` held a general-purpose role, but the
owner chose luna so a default that nobody asked for stays the cheapest live model
(owner decision, 2026-09-12).

## Constraints and scope boundary

In scope: `src/codex/**`, `src/oauth/**`, `src/vision/**`, the Codex-login parts of
`src/server/**`, `src/cli/**`, `src/types/**`, `src/lib/shadow-call.ts`, `gui/`,
`docs/` (the maintainer-facing pages, not only `docs-site/`), `docs-site/` (all locales),
`structure/`, `scripts/release-notes.ts`, and `tests/`.

Out of scope, deliberately:

- Third-party vendor rosters that publish their own snapshots — `github-copilot`
  (`src/providers/registry.ts`), `cursor` (`src/adapters/cursor/*`), `codebuddy`,
  `opencode`, `command-code`, and `scripts/model-metadata.source.json`. This follows
  the `deepseek-v4-pro` precedent (`e86ab5bd8d`): a first-party retirement notice does
  not end a vendor's deployment, and deleting their row would strip a live route's
  context window and effort ladder while the model keeps arriving from `/models`.
- Historical pricing in `src/usage/expected-prices.ts` and its tests. Past usage rows
  still have to cost correctly after the model stops being routable.
- Slugs that only look related: `gpt-5.4-nano`, `gpt-5.4-pro`, `gpt-5.4-high`,
  `openai/gpt-5.4-mini` (OpenRouter metadata). None are part of this retirement.

No push, PR, merge, release, or deploy. Local commits only.

## Evidence gathered at P

Three read-only `xai/grok-4.6` verifier subagents swept the tree in parallel. Their
combined inventory: 146 files, 592 `gpt-5.4*` hits, of which the Codex-login-owned
set is the one this unit changes.

Structural findings that shape the phase order:

1. `NATIVE_OPENAI_MODELS` (`src/codex/catalog/native-models.ts:156`) is the single
   membership list. `SUPPORTED_NATIVE_OPENAI_SLUGS`, `nativeModelRows`,
   `nativeOpenAiSlugs`, `accountBoundNativeOpenAiSlugsBySelector`,
   `filterSupportedNativeSlugs`, `model-routes.ts` `supportedNative`, and
   `CANONICAL_NATIVE_CATALOG_CONTENT_POLICY.nativeBackfillSlugs` all derive from it.
   Removing the two slugs there propagates to every projection without further edits.
2. Persisted BARE rows clean themselves up. Once the slugs leave the list,
   `isUnsupportedOpenAiNativeSlug` returns true for `gpt-5.4` and `gpt-5.4-mini` and the
   canonical merge runs `unsupportedNativeEntries: "drop"` (`sync.ts:847`, filter at
   `1068-1070`), so a user's on-disk catalog loses them on the next sync.
   Account-namespaced rows are a different path: that predicate returns false for any slug
   containing `/` (`metadata.ts:113`), so `team/gpt-5.4` is not dropped by it. Those rows
   stop being *generated* because `accountBoundNativeOpenAiSlugsBySelector` and
   `availableAccountNativeSlugs` both seed from `NATIVE_OPENAI_MODELS`. wp2 must prove what
   happens to an already-persisted `selector/gpt-5.4` row with a focused test rather than
   assuming it disappears.
3. `UPSTREAM_NATIVE_ENTRIES` never contained either slug — `upstreamNativeEntryForSlug`
   admits only `gpt-5.6-*` and self-described natives — so deleting the two pinned rows
   in `src/codex/data/upstream-models.json` changes capability fallbacks only, not the
   sync-replacement authority. `gpt-5.2` and `codex-auto-review` stay pinned, which is
   why `SELF_DESCRIBED_NATIVE_OPENAI_MODELS` must remain an explicit allowlist.
4. The defaults are independent of the catalog list and fail separately. Warmup
   (`src/codex/warmup.ts:30`), the token guardian (`src/oauth/token-guardian.ts:55`),
   and the vision describer (`src/vision/plan.ts:14`) all still dispatch
   `gpt-5.4-mini` and would 404 after retirement regardless of catalog membership.
5. The startup sidecar migration (`src/server/index.ts:686`) rewrites a *stored*
   `gpt-5.4-mini` to `gpt-5.6-luna`, but an unset vision model never equals that
   string, so it falls through to `DEFAULT_VISION_MODEL` and still calls the retired
   model. That gap is the reason wp3 exists as its own cycle.
6. `DEFAULT_SHADOW_SOURCE_MODELS` is already `["gpt-5.6-luna"]`. `gpt-5.4-mini` there
   is an *inbound* prefix for Codex 0.144.x helper calls, not a dispatch target, so it
   stays documented as a restore option and is not treated as a retired default.

## Work-phase map

| Phase | Unit doc | Outcome | Depends on |
|---|---|---|---|
| wp1 | this document | Roadmap locked, scope boundary recorded | — |
| wp2 | `010_catalog_removal.md` | The two slugs leave the native catalog and its pinned metadata | wp1 |
| wp3 | `020_defaults_repoint.md` | Every opencodex-owned default moves to a live slug | wp1 |
| wp4 | `030_surfaces_and_gate.md` | GUI, docs locales, structure docs, full gate, closing record | wp2, wp3 |

wp2 and wp3 touch disjoint files and could run in either order; wp2 runs first because
its membership decision is what the wp3 tests assert against.

## Risks

- **Over-removal.** Deleting a vendor roster row would break a live Copilot or Cursor
  route. Mitigation: the scope boundary above, plus a final `rg` sweep that expects
  vendor hits to remain.
- **Under-removal.** A default left on `gpt-5.4-mini` turns into a silent 404 on every
  warmup or image description. Mitigation: wp3 enumerates each default site explicitly.
- **Test churn masking a real break.** ~278 test hits are in scope. Mitigation: each
  test edit is classified as membership (must change), floor (must repoint), or
  historical (must not change), and the full suite is the closing gate.

## Acceptance

DONE requires: no retired slug in a Codex-login-owned surface, every default on a live
slug, `bun run typecheck` clean, the focused domain suites green, the full
`bun run test` green, `bun run structure:check` green, and this unit carrying a closing
record with quoted evidence.
