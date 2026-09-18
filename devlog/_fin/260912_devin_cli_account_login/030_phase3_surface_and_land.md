# 030 — Phase 3: surface, docs, and landing

**Work-phase:** wp4. **Write set:** `gui/src/pages/providers-shared.ts`,
`docs-site/` English + 7 locales, `structure/` docs, PR.

Rewritten after audit rounds 1 and 2. The first draft targeted
`gui/src/provider-icons.ts`, which is the wrong surface (blocker 4).

## GUI — the label lives in OAUTH_LABELS

Accounts rows resolve their title through `oauthLabel(id)` →
`OAUTH_LABELS[id] ?? id` (`gui/src/pages/providers-shared.ts:49-59`, consumed at
`gui/src/pages/providers-page-utils.ts:21-23`). `formatProviderDisplayName`
already returns "Devin CLI" but oauth rows never call it, so without a new entry
the row reads `devin-cli`.

```diff
 const OAUTH_LABELS: Record<string, string> = {
   ...
+  "devin-cli": "Devin CLI",
 };
```

The icon needs nothing: `devin-cli` already maps to `devin.svg`.

### The `local` badge disappears on its own

`ProviderCatalog.tsx`'s badge ladder draws the amber `modal.badge.local` chip
from `p.auth === "local"`, and `derive.ts:613` derives that from `authKind`.
Once the registry says `oauth` the chip is gone and the row is an Accounts login
row instead — which is the mark the operator asked to have removed. Nothing to
edit; wp4 verifies it rather than assuming it.

### Rail, not only the modal

`gui/src/provider-workspace/auth.ts:21-22` returned `null` for local, and
`kind.ts:12-21` classified the row as kind `local`. Under `oauth` both change:
the row becomes a login kind and an auth surface is drawn. Check that surface
does not offer an API-key field for a provider that takes no key — that would be
a regression this unit introduced.

## Docs

English:

- `docs-site/src/content/docs/reference/adapters.md:458-459` — "none held by
  opencodex ... stores no key and asks for none." Keep the true half, add the
  account row and the one-time sign-in.
- `docs-site/src/content/docs/guides/providers.md:196` — same sentence in the
  table.

Locale copies of that sentence, all of which assert opencodex stores no key (still
true; the sign-in sentence is added): `ko:117`, `ja:119`, `zh-cn:111`,
`zh-tw:116`, `fr:130`, `ru:128`, `tr:143`.

Upgrade note, from `020`: an existing user's first turn after upgrade returns
`OAuthLoginRequiredError` until one sign-in. Import-first makes that click
complete without a browser.

## structure/

`structure/AGENTS.md:49` binds `src/oauth/` and `src/providers/` changes to
`runtime.md`, `subagents.md`, `transports/inventory.md` and
`providers/xai-grok.md` — not only `adapters/registry.md`, which the first draft
named alone. Read each and update any sentence this change falsifies;
`structure/adapters/registry.md:16-25` says the two Devin adapters have
"separate credentials", which stays true and gains the account row.

## Proof against the running service

1. `GET /api/oauth/providers` lists `devin-cli`.
2. `GET /api/provider-presets` does NOT list it (blocker 2 regression guard).
3. The Accounts tab renders a **Devin CLI** row beside devin, with no `local`
   badge — screenshot, which the PR needs anyway because `gui/` changed.
4. `ocx login devin-cli` completes without a browser against the already
   signed-in CLI, and a `codex exec -m devin-cli/swe-2` turn answers afterwards.
5. The 401-before / success-after upgrade behaviour is exercised, not asserted.

## Landing

Branch from a freshly fetched `origin/dev`, push `--no-verify`, PR into `dev`
with the screenshot, hosted CI green on the exact head, merge, prove ancestry
from a fetched `origin/dev`.

## Acceptance

Every goalplan criterion met with fresh evidence, including an explicit statement
of the one-time sign-in required after upgrade.

