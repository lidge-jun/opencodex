# Design B — Inject by Overriding the `openai` Provider Id (P draft)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C4 (provider identity,
  chat-history integrity) — full PABCD; user approved investigating B and, if the design
  audits clean, implementing it.
- **Goal:** keep `model_provider = "openai"` in Codex config and override
  `[model_providers.openai]`'s base_url to the local proxy, so threads never change
  `model_provider` → the entire "restore failed → history hidden" class disappears
  (see 01_codex-rs-facts.md for the list-filter mechanism).

## opencodex-side dependency map (first-hand, verified this session)

| Area | Finding | Impact under B |
|---|---|---|
| Inject writer | `codex-inject.ts` is the ONLY writer of the provider id: root `model_provider = "opencodex"` (:121-127, :231), `[model_providers.opencodex]` table (:48-64), `[profiles.opencodex]` profile file (buildProfileFile). Table already sets `requires_openai_auth = true` + `wire_api = "responses"` + optional `env_http_headers` for `OPENCODEX_API_AUTH_TOKEN`. | Rewrite to emit `[model_providers.openai]` and DROP the root `model_provider` line entirely (default id is already `openai`). Auth semantics unchanged — Codex already attaches OpenAI/ChatGPT auth to the proxy today. |
| Detect/strip/restore | Detection & removal key on `OCX_SECTION_MARKER` comment + literal table header (:262, :312-340). Journal (`codex-journal.ts`) stores the ORIGINAL config verbatim (base64) and restore prefers it. | Marker comment stays the primary detector. Strip must remove the marker-adjacent `[model_providers.openai]` table WITHOUT touching a user's own pre-existing openai override elsewhere (journal restore already handles the exact-bytes case). Must ALSO keep stripping the legacy `opencodex` table + root line for upgrades. |
| Server/routing | Proxy routes by model slug (`<provider>/<model>` namespaced in the catalog, bare gpt slugs passthrough — codex-catalog.ts:544-560). The codex-side provider id never reaches routing. | No change. |
| Usage/quota | Attribution uses ocx's own provider names (usage folds ChatGPT pool + OpenAI passthrough into one `openai` row already). | No change. |
| Catalog | `model_catalog_json` entries carry no codex provider id. | No change. |
| History provider | Forward re-tag becomes obsolete; restore/eject machinery stays as ONE-TIME migration (existing `opencodex`-tagged rows → `openai`) and for downgrade cleanup. `syncResumeHistory` config becomes migration-gating only. | `injectCodexConfig` runs `syncCodexHistoryProvider("openai")` once (migration), never forward again. Backup manifest cleared afterward. |
| Product-name strings | healthz `service:"opencodex"`, oauth ORIGINATOR, GUI labels, `comp_hash` marker — product identity, NOT the provider id. | No change. |

## codex-rs side (pending — background investigation running)

Blocking questions before A-phase:
1. `[model_providers.openai]` merge semantics: replace vs field-merge vs ignored for built-ins.
2. Behavior keyed to id "openai" beyond auth (rate-limit UI, chatgpt backend usage calls,
   catalog defaults) once base_url points at localhost.
3. Whether the override can/should keep `wire_api = "responses"` and what auth headers reach
   the custom base_url.
Verdict line expected: "override viable: yes/no/partial".

## Migration sketch (ordered)

1. `buildProviderTableBlock`/`buildProfileFile` emit `openai` table id; root model_provider
   line no longer injected; profile keeps `--profile opencodex` NAME but sets no
   model_provider (or sets "openai").
2. Strip/detect: support BOTH legacy (`opencodex` table + root line) and new
   (marker-adjacent `openai` table) forms — upgrade path = old install's config cleaned.
3. One-time history migration on first B-inject: restore-with-backup + eject (existing
   machinery), THEN stop writing forward tags. Loop-1 hardening (retry + failed:true +
   warnings) stays for the migration path.
4. `ocx restore` keeps meaning "remove proxy override" (config-only now — no history
   mutation needed after migration); `restore back` re-injects.
5. Tests: codex-inject test matrix (fresh inject, re-inject over legacy form, restore with
   user's own `[model_providers.openai]` present pre-injection, journal-less strip).

## Open risks

- Codex updates that hard-code base_url for id "openai" or ignore overrides for built-ins
  (codex-rs answer pending) — would kill the design.
- A user's genuine custom `[model_providers.openai]` override: inject must journal it and
  restore must return it byte-exact (journal already does); marker-scoped strip protects
  the journal-less path.
- Downgrade (new → old ocx): old strip won't recognize the openai-table form → stale
  proxy override left behind if journal also lost. Mitigation: keep marker comment format
  identical so even old strips that key on the marker line remove the block. VERIFY old
  strip behavior before shipping.
