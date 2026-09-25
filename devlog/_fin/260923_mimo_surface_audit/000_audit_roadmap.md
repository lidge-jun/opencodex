# 260923 MiMo surface audit — findings and roadmap

## Problem

After #5611 and #5637 fixed Command Code MiMo tool-call text, the user asked for an exhaustive pass over
every other Xiaomi MiMo surface. Xiaomi shipped the V2.6 family (`mimo-v2.6-pro`, `-pro-ultraspeed`,
`-flash`) and announced that `mimo-v2.5` / `mimo-v2.5-pro` stop working on 2026-10-21 10:00 Beijing time
with no automatic redirect ([deprecation notice](https://mimo.mi.com/docs/en-US/updates/deprecate)). Most
of opencodex still stops at V2.5.

## Method

Three read-only gpt-6-sol auditors over disjoint slices (reports in `.tmp/mimo-audit/{A-runtime,B-catalog,C-docs}.md`,
scratch): A runtime/adapters, B catalog/metadata/pricing against live upstream, C docs/structure/locales.
Main verified each finding in source (path:line below) and pulled the current models.dev record
(`https://models.dev/api.json`, fetched 2026-09-23, scratch copy `.tmp/mimo-audit/models.dev.json`).

## Surface inventory

| Surface | Where | V2.6 today |
|---|---|---|
| Xiaomi Anthropic preset `xiaomi` | `src/providers/registry/entries-extended.ts:1142` | default `mimo-v2.5-pro`, no roster |
| Xiaomi Chat preset `xiaomi-mimo` | `entries-extended.ts:1148-1160` | default/roster `mimo-v2.5` only |
| Xiaomi token plan `mimo` | `entries-extended.ts:1188-1209` | default `mimo-v2.5-pro`, roster V2.5 only |
| MiMo Free `mimo-free` | `src/adapters/mimo-free.ts`, `entries-extended.ts:1162-1177` | opaque `mimo-auto` (correct) |
| Command Code OAuth/key | `src/adapters/command-code.ts`, `command-code-tool-text.ts`, `command-code-efforts.ts` | live ids; markup filter gated to V2.6 only |
| OpenCode Go | `src/providers/registry/entries-core.ts:876-885`, `model-seeds.ts:272-274` | toggle/vision tables V2.5 only |
| OpenCode Zen | `model-seeds.ts:401-417` | image hint for V2.5 free only |
| Cline Pass (static catalog) | `model-seeds.ts:944-1012` | V2.5 only |
| DigitalOcean | `model-seeds.ts:881` | V2.5 Pro only |
| Bundled metadata | `scripts/model-metadata.source.json` → `src/generated/model-metadata.ts` | no V2.6 rows anywhere |
| Docs | `docs-site/.../guides/providers.md` (+7 locales), `reference/adapters.md` | see C findings |

## Findings and dispositions

| ID | Class | Finding (verified evidence) | Disposition |
|---|---|---|---|
| A-01 | defect | `mimo-free.ts:225` `buildRequest` calls `getMimoJwt()` without the caller's abort signal; an aborted first turn waits for the bootstrap (up to 15 s). | Fix in wp3 (020) |
| A-02 | defect | `mimo-free.ts:162-180` shares one bootstrap promise created with the first caller's signal; aborting that caller fails every concurrent waiter. | Fix in wp3 (020) |
| A-03 | defect | `command-code.ts:600` enables MiMo markup dedupe/restore only for `xiaomi/mimo-v2.6-*`; Command Code still serves `xiaomi/mimo-v2.5`/`-pro` (fixture) and third-party reports show the same markup leaking there (patlux/pi-commandcode-provider#110). | Fix in wp3: gate on the `xiaomi/mimo-` family |
| B-CAT-01 | defect (to prove) | Command Code presets have no static MiMo ids, so a cold/failed discovery cannot decode `command-code/xiaomi-mimo-v2.6-pro`. | wp3: red test first; fix only if red |
| B-CAT-02 | defect | No V2.6 price anywhere: `resolveMatchedPrice` returns null for Xiaomi/OpenRouter/Go/Command Code V2.6. | Fix in wp2 via models.dev rows |
| B-CAT-03 | stale | Xiaomi presets default to and list only V2.5; V2.5 dies 2026-10-21. | Fix in wp2 (new defaults + roster; saved configs untouched) |
| B-CAT-04 | cleanup | Expired first-party `xiaomi/mimo-v2-{flash,omni,pro}` rows stay in metadata. | Rejected: no preset advertises them; removing them would unprice historical usage rows. |
| B-CAT-05 | inconsistency | No V2.6 context/output/modality facts. | Fix in wp2 with the metadata rows |
| B-EXT-06 (main) | stale | OpenCode Go thinking-toggle/vision tables, Cline Pass static catalog and context/image tables stop at V2.5; models.dev lists V2.6 on both. | Fix in wp2 |
| C-DOC-01 | inconsistency | `guides/providers.md:588-589` (+7 locales) calls Xiaomi Anthropic-only although a Chat preset exists. | Fix in wp4 (030) |
| C-DOC-02 | stale | 7 locale guides still carry the pre-#5611 Command Code paragraph. | Fix in wp4 |
| C-DOC-03 | inconsistency | `reference/adapters.md:214-218` omits the clean-finish condition for restoration. | Fix in wp4 |

## Not changed (recorded)

- Command Code MiMo effort ladder: no published ladder; needs a live `/alpha/generate` probe. Follow-up.
- Gateway image support for V2.6 on Command Code, Zen free and Cline Pass is unverified: first-party modality does not prove a gateway forwards images, and positive image hints need a route probe (`model-seeds.ts:327-387` policy). Static tables leave V2.6 out of their image sets; the sidecar keeps images working.
- DigitalOcean V2.6: no catalog evidence found. Not applicable until listed.
- Migrating saved configs off V2.5 before 2026-10-21: explicit user choices stay; recorded as a dated follow-up.
- Routing the Command Code OAuth preset over `/provider/v1`: follow-up from #5637.

## Work-phase map (dependency order)

1. wp1 — this audit and roadmap (docs only).
2. wp2 — catalog facts: metadata rows + regenerate, Xiaomi presets, OpenCode Go, Cline Pass (`010_wp2_catalog_v26.md`).
3. wp3 — runtime: MiMo Free abort, Command Code family gate, cold-start decode (`020_wp3_runtime.md`).
4. wp4 — docs in English and 7 locales, then PR, CI, merge (`030_wp4_docs_delivery.md`).

One branch `codex/mimo-surface-audit`, ordered commits, one PR to `dev`.
