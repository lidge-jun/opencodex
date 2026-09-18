# 031 — Phase 3 (revised): surface, docs, and landing

**Supersedes `030`.** Same surfaces, new transport, and the proof list changes
because there is now a real credential to prove with.

**Work-phase:** wp4. **Write set:** `gui/src/pages/providers-shared.ts`,
`docs-site/` English + 7 locales, `structure/` docs, PR.

## GUI

Accounts rows title through `oauthLabel(id)` → `OAUTH_LABELS[id] ?? id`
(`gui/src/pages/providers-shared.ts:49-59`, consumed at
`gui/src/pages/providers-page-utils.ts:21-23`). Without an entry the row reads
`devin-cli`.

```diff
 const OAUTH_LABELS: Record<string, string> = {
+  "devin-cli": "Devin CLI",
 };
```

The icon already maps to `devin.svg`. The amber `local` badge disappears on its
own once `auth` stops being `"local"`; verify rather than assume. Check the rail
too: `provider-workspace/auth.ts` and `kind.ts` both change branch under
`oauth`, and the auth surface must not offer an API-key field for a row whose
credential is imported.

## Docs

The English sentences at `docs-site/src/content/docs/reference/adapters.md:458-459`
and `docs-site/src/content/docs/guides/providers.md:196` currently describe a
stdio ACP provider that holds no key. Both halves change: the preset now imports
the CLI's token and streams over Connect-RPC. The seven locale copies of the
table row follow (`ko:117`, `ja:119`, `zh-cn:111`, `zh-tw:116`, `fr:130`,
`ru:128`, `tr:143`).

Say plainly what is imported and what is not: opencodex adopts the
`windsurf_api_key` the CLI already wrote, and never reads anything else from that
file.

Also document the surviving ACP escape hatch: an explicit
`"adapter": "devin-cli"` still drives `devin acp`.

`structure/AGENTS.md:49` binds `src/oauth/` and `src/providers/` changes to
`runtime.md`, `subagents.md`, `transports/inventory.md` and
`providers/xai-grok.md`. `structure/adapters/registry.md:16-25` says the two
Devin adapters have "separate transports, separate credentials" — the credential
half is now false for the preset and must be corrected.

## Proof against the running service

1. `GET /api/oauth/providers` lists `devin-cli`; `GET /api/provider-presets` does not.
2. `ocx login devin-cli` imports without opening a browser, against the already
   signed-in CLI.
3. `codex exec -m devin-cli/<model>` answers — the `CLIKEY-OK` shape, now through
   the shipped provider rather than a scratch script.
4. The model list is the live catalog, and a spot-checked context window matches
   `ClientModelConfig` field #18 rather than a static table.
5. Accounts tab screenshot: a **Devin CLI** row beside Devin, no `local` badge.
   The PR needs it anyway because `gui/` changed.

## Landing

Branch from a freshly fetched `origin/dev`, push `--no-verify`, PR into `dev`
with the screenshot, hosted CI green on the exact head, merge, prove ancestry from
a fetched `origin/dev`.

