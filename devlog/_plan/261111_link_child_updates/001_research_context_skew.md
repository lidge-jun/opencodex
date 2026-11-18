# R1 — Why 1M-context Home models show ~250k on a Child

Researched 2026-11-11 in <checkout> (origin/dev 00680193cb). Read-only; this machine is a link Child running ocx 2.93.0 (~/.opencodex-desktop/bin/ocx).

## Verdict

The ~250k number is Codex's built-in fallback for a model slug that is **absent from the catalog Codex has loaded**: 272,000 x 95% = **258,400**. The hypothesis is half right. The fallback mechanism is confirmed. The proposed cause (a Child-side projection that drops or rewrites the context window) is **refuted**: the Child copies the Home's /v1/catalog bytes verbatim, and no catalog field, shape or parser changed between v2.93.0 and dev.

The two real triggers, both observed on this machine (high confidence):

1. **Stale Child catalog file.** The Child catalog is rewritten only by an explicit sync (Child ocx sync, the machine API, or Home ocx sync fan-out from Home 2.97+). Models added on the Home in the meantime still route (the Child relays every request to the Home) but are missing from the Child's catalog, so Codex uses fallback metadata.
2. **Stale in-memory catalog in a long-running Codex app-server.** Even after the file is rewritten, an app-server started earlier keeps its startup copy until it restarts. The repo already says this: src/codex/catalog-auto-refresh-sources.ts:57 ("running sessions own static copies and require an operator restart"), and src/codex/catalog-auto-refresh.ts:267.

The ocx version of the Child is not what clips the window. "Outdated Child" correlates with the symptom because an old Child gets fewer catalog refreshes and has no way to carry restart-codex. It does not lose fields.

## 1. End-to-end path of the context window

Field names in a catalog row, written by the Home and kept unchanged: context_window, max_context_window, effective_context_window_percent (95), auto_compact_token_limit. Codex computes model_context_window = context_window x effective_context_window_percent / 100 (e.g. 1,000,000 -> 950,000 and 1,048,576 -> 996,147, both seen in rollouts).

**TS Child (ocx)**

- src/client/hub-client.ts:437-480, downloadClientCatalog: GET {origin}/v1/catalog with x-opencodex-api-key. validateRemoteCatalog (hub-client.ts:142-160) checks only the object shape, at most 2000 rows, and unique non-control slugs. It never looks at context fields. The size cap is MAX_REMOTE_CATALOG_BYTES = 256 MiB, the same at v2.93.0 and on dev (src/server/catalog-download.ts:29).
- src/client/connect.ts:932: assertClientCatalogCompatible (#4207 effort gate, src/client/catalog-compatibility.ts) can refuse the **whole** catalog when the local Codex CLI does not know a reasoning effort. That leaves the old file in place, which is another way to end up stale (not observed here).
- connect.ts:939 atomicWriteFile(DEFAULT_CATALOG_PATH, downloaded.body) writes the bytes verbatim to $CODEX_HOME/opencodex-catalog.json, then records catalogFingerprint (sha256 base64url) and catalogSyncedAt (connect.ts:940-944). Connect does the same at connect.ts:724.
- connect.ts:970-976 injectCodexConfig points Codex at the catalog through config.toml model_catalog_json and openai_base_url (here ~/.codex/opencodex.config.toml). Nothing writes model_context_window or model_auto_compact_token_limit; this machine's ~/.codex/config.toml has only model_catalog_json at line 4.
- connect.ts:991-998 invalidateCodexModelsCacheWithPermit (src/codex/catalog/sync.ts) rewrites ~/.codex/models_cache.json from the catalog rows, with fetched_at 2000-01-01 and client_version 0.0.0.

**Rust Child (native/ocx-child)**

- cli.rs:769-805 pulls Home /v1/catalog. journal.rs:206-262 (prepare_codex_models_cache / render_codex_models_cache) writes catalog rows verbatim, plus retained observed-native rows, into models_cache.json. state.rs:51-55 sets the paths. This path also contains no context-field logic. Conformance coverage: native/ocx-child/tests/conformance.rs:1479-1519.

## 2. v2.93.0 -> origin/dev (463 commits)

- git log -G'max_context_window|auto_compact_token_limit|effective_context_window_percent' v2.93.0..origin/dev -- src finds only 2b5148b124 (#7701, first in v2.94.0). That commit changes Home-side xAI Grok ladder values (src/codex/catalog/model-hints.ts) and no field names or shape.
- The src/client/hub-client.ts diff is +5 lines and src/client/connect.ts is +35/-15 (sync restart deferral #8250, route intent #8274). The catalog parser, the verbatim write and the size cap are all unchanged. src/codex/catalog changes since v2.93.0 (#8419, #8404, #7889, #7839, ...) do not touch the context fields.
- No catalog format version, nested window, or renamed field exists. An old Child cannot drop the window, because it never parses it.
- Relevant behaviour changes that bear on staleness:
  - 959a07a5ea (#7694/#7707, v2.93.0) adds sync --expect-link to the Child.
  - 4948c04d9c (#8100, v2.97.0) makes Home ocx sync fan out to Children. The minimum Child is 2.93.0 (src/cli/sync-fanout.ts:14, with exit 121 child-ocx-lacks-expect-link), and the fan-out runs **without** a restart flag (src/link/ssh-argv.ts:367; structure/remote-link.md:9).
  - 540100d2c1 (#8248, v2.98.0) reports skipped children as partial.
- The Home's background catalog auto-refresh does **not** reach Children. Its client fan-out, refreshConnectedClientsAfterCatalogChange (src/server/background-lifecycle.ts:91-107, introduced by d17a9f2239, #6836), syncs only the Home's own local integrations and is gated by localClientSyncAllowed. A Child has no periodic re-pull: no timer in src/client, and syncConnectedClient is called only from src/cli/sync-command.ts:53 and src/client/machine-api.ts:104.

## 3. Evidence from this machine (2.93.0 Child)

- ocx --version reports opencodex 2.93.0. ~/.opencodex/config.json has runtimeRole "client" and catalogSyncedAt 2026-11-10T05:55:17Z (14:55 KST).
- ~/.codex/opencodex-catalog.json has 29 rows, and every 1M model carries the correct values. For example, anthropic/claude-opus-5-5 has 1000000 / 1000000 / 95 / 900000; hyds/deepseek-v4.1-flash-1m and mistral/deepseek-v4-1-flash-1017 have 1048576 / 1048576 / 95 / 943718. models_cache.json has the same rows and values (fetched_at 2000-01-01, client_version 0.0.0).
- Audit log ~/.codex/opencodex-catalog-audit.jsonl:
  - 2026-11-08T12:07Z cache-invalidate routed 11->13.
  - 2026-11-10T05:55Z routed 13->19.
  - The Child catalog changed only at these two syncs.
- Rollouts in ~/.codex/sessions/2026/11 (turn_context model and token_count model_context_window, plus session_meta cli_version):
  - Nov 9 to Nov 11 00:xx (cli 0.163.0): mistral/deepseek-v4-1-flash-1017, hyds/deepseek-v4.1-flash-1m, hyds/deepseek-v4.1-flash-free and anthropic/claude-fable-5-2 (once) all show **258400**. Over the same period, anthropic/claude-opus-5-5 and command-code/... show 950000.
  - The 258400 values continue on Nov 10 at 19-20h and Nov 11 at 00h, **after** the 14:55 catalog write that already contained these models at 1M. The file was correct, but the running app-server was not.
  - From Nov 11 ~01:00 (cli 0.167.0, fresh GOAT app-server) the same models show 996147 and 190000, which are correct. GOAT's app-server pid file and process date from 02:24 today. A second app-server, an older app-server process, has run since **Oct 28**, which is older than the catalog mtime, so by the repo's own rule (src/codex/app-server-processes.ts:958) it is "stale" now.
  - Caveat: the 0.163 -> 0.167 switch coincides with the app-server restart, so a Codex-version factor cannot be fully excluded. Against it: identical row shapes (anthropic/claude-opus-5-5 vs anthropic/claude-fable-5-2) got different results under 0.163, and one 0.163 session moved from 190000 to 258400 mid-session, which fits per-process snapshots.
- Live Home catalog read through the Child loopback (GET 127.0.0.1:10100/v1/catalog, read-only) returned 31 rows, while the Child file has 29. The Home now has anthropic/claude-sonnet-4-5-20250929 (1000000), google-antigravity/gemini-4-carbon (1048576) and system24/deepseek-v4.1-flash (200000), which the Child lacks. The Child still lists command-code/deepseek-deepseek-v4.1-flash-fast, which the Home dropped. A new session on gemini-4-carbon would show 258400 today.

## 4. Conclusions and fix surface

**Root cause:** catalog freshness at two layers, (a) the Child file and (b) a running Codex app-server snapshot, combined with Codex's 272k fallback for unknown slugs. Confidence: high for the mechanism and both layers on this machine. There is no evidence of a field-level incompatibility.

**What the Home can and cannot fix for deployed Children:**

- Field shape: nothing is needed. Home already emits the fields a 2.93 Child copies verbatim, so a "compatible shape by peer version" is not required.
- Child file freshness: fixable from the Home for Children at 2.93.0 or later, using the existing pinned fan-out (sync --expect-link). Children older than 2.93.0 are skipped (child-ocx-lacks-expect-link) and need an update.
- Child app-server restart: needs the Child to accept a restart. The existing Child CLI already accepts sync --restart-codex (src/cli/sync-command.ts:41-53), so the Home could append it to the pinned script when the operator opts in, gated on a minimum Child version that has the flag together with --expect-link (verify that 2.93.0 parses both together before relying on it).

Files a fix would change:

- src/server/background-lifecycle.ts (refreshConnectedClientsAfterCatalogChange) or a new Home hook: after a Home catalog change (auto-refresh tick or management mutation), fan out to linked Children through the src/cli/sync-fanout.ts / sync-fanout-process.ts runner. Alternatively, mark Children "catalog behind" and let the operator push.
- src/link/ssh-argv.ts (around :360-367) and src/link/remote-windows.ts: an opt-in restart-codex argument in the pinned sync script. src/cli/sync-command.ts / sync-fanout.ts: the --restart-codex plus single-Child target plumbing (the planned PR).
- src/link/child-parity.ts (LinkChildParityReport, :28-42; strict parser :66-77) and src/client/link-parity-reporter.ts: report catalogFingerprint and catalogSyncedAt (already stored by connect.ts:940-944), and optionally the Codex app-server catalog state (collectCodexAppServerCatalogStateWithin, src/codex/app-server-processes.ts:913-959). The strict parser rejects unknown fields, so new fields need a new feature id or report version advertised through src/remote/features.ts / peer-report.ts. An old Home would otherwise drop the whole report.
- Home side, src/link/status-projection.ts (attachLinkPeers): compare the Child's catalog fingerprint with the fingerprint of the body /v1/catalog would serve that link key, and show "catalog behind" or "Codex needs restart".

**Detection today (no Child changes):**

- Peer report (src/link/peer-report.ts): x-opencodex-link-peer-version and -features on the relay-auth challenge, from Children at 2.91.0 or later. This gives the version, so the Home can flag 2.93.0 < npm latest and any Child below the fan-out minimum of 2.93.0. linkPeerStatus (src/link/compatibility.ts) gives compatible, degraded, incompatible or unknown.
- Parity report (src/link/child-parity.ts): only lastApplyAt, runtimeStartedAt, appliedCodexSettingsDigest and sequence. It carries **no catalog freshness**, so the Home cannot see this bug today beyond inference from version or last fan-out.

**Regression test ideas:**

1. Home-side: a fan-out test in which a Home catalog change triggers a Child sync for a link Child (fake runner), and the --restart-codex opt-in reaches the pinned argv only when requested and only for a Child version at or above the minimum.
2. Parity: a report carrying catalogFingerprint that differs from the Home's per-key fingerprint projects "catalog behind" in GET /api/link/status?compatibility=1. A report without the field still validates on both old and new Homes.
3. An end-to-end oracle: for every Home catalog slug, the Child catalog row's context_window equals the Home row after sync. This pins the "verbatim" invariant so no future projection can clip it.

NOT RUN: no tests were run (read-only brief). The Codex fallback constant (272000 with 95%) is inferred from the observed arithmetic (258400 = 272000 x 0.95 across 3 unrelated slugs). The Codex source was not available locally.

