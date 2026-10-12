# Sponsor overview presentation

Satisfy-spec, C2, one shared UI slice delivered to existing independent PRs #3914 and #3915. Trigger: the maintainer requested concise marketing copy, hyperlinks, tidy design and PR screenshot mockups. Stop after both remote branches and PR descriptions are updated with truthful verification. No merge, release, deployment, credential changes, outreach or new dependencies. No user-defined resource budget; use existing local tools and remote macmini-cf for heavy validation. This document and the local goalplan hold evidence. Escalate only a conflicting remote edit, inaccessible publication or unrelated baseline failure requiring broader scope; report incomplete evidence honestly.

## Design read

Developer dashboard, existing neutral theme and system font. Keep compact connection facts and quota data; introduce one quiet sponsor strip with product identity, a two-line value proposition, explicit Sponsor disclosure and named outbound actions. No hero, animation, invented discount or performance claim. Variance 3/10, motion 1/10, density D5. Reuse existing ProviderIcon, button/link tokens and locale dictionaries. Desktop strip places copy and actions side by side; narrow containers wrap actions below copy. Screenshot mockups use actual components and synthetic account/usage values, labelled as fixtures in PR prose. Utility dashboard exemption: no generated concept images.

## Existing owners and necessity

- `gui/src/pages/Providers.tsx:289`: existing cached `/api/provider-presets` request; consume its result instead of adding a request/store.
- `gui/src/components/provider-catalog/provider-presets.ts:17`: CatalogPreset already owns sponsor/sponsorUrl/dashboardUrl/note. No backend field or persistence change.
- `gui/src/components/provider-workspace/ProviderDetails.tsx:265`: pass the matched preset to Overview.
- `gui/src/components/provider-workspace/ProviderOverview.tsx:186`: note is duplicated in connection facts and NotesSection. Remove the duplicate and move the existing editable NotesSection into the wider main column. Preserve full note and its editing behavior for every provider.
- `gui/src/styles/provider-workspace-shell.css:606`: existing responsive grid/tokens.
- Searched preset matching, sponsor fields, Overview callers and note-save tests; no equivalent overview sponsor presentation exists. Configuration alone cannot add links to the current text-only view.

## Diff map

1. MODIFY Providers cached request typing to CatalogPreset[] and pass matching preset; match canonical id + adapter + normalized endpoint (trailing slash tolerated); mismatched endpoints or absent presets produce no sponsor strip. Do not infer endorsement from name alone. Reuse cache; no new fetch.
2. MODIFY ProviderDetails and ProviderOverview optional preset prop. NEW small ProviderSponsor component in provider-workspace: render only known sponsor identities with active sponsor metadata; localize concise OrcaRouter adaptive-routing and PackyCode multi-tool API-relay descriptions. Preserve exact existing affiliate URL, expose dashboard link only when distinct, HTTP(S) only, new-tab noopener/noreferrer. No HTML parsing of notes.
3. MODIFY Overview: render sponsor strip above columns; remove connection note row, put existing NotesSection after auth summary, leaving right column stats/quota only. Full user note remains visible/editable once.
4. MODIFY existing workspace stylesheet for strip layout, subtle border, readable copy/actions and note wrapping. MODIFY all locale dictionaries for every added key.
5. NEW focused GUI render tests for sponsor links/disclosure, missing/non-sponsor/custom-endpoint cases; extend existing note test to assert exactly one note and continued editing. No root test-map change for GUI tests.
6. MODIFY providers guide and GUI SoT for sponsor overview behavior. ADD desktop and narrow actual-render PNGs per sponsor under existing assets/sponsors; update both PR descriptions, preserving prior scope and verification distinctions.

## Acceptance and validation

- Active OrcaRouter API and OAuth presets show the strip only for their configured endpoint; PackyCode only on its sponsor branch. Missing catalog, non-sponsor and changed endpoint remain ordinary provider views. Focused tests activate each branch.
- Exact sponsorURL survives, duplicate dashboard URL is suppressed, unsafe URLs do not become anchors. Provider limitations and arbitrary user note remain complete and occur once; note-save failure keeps draft/error.
- Run focused GUI tests (new sponsor tests plus existing notes, catalog sponsor-pinning and locale parity), lint:i18n, lint and GUI build. Existing scripts confirmed in gui/package.json; target files/locale imports prove coverage. Fresh execution recorded in C, not claimed from script existence.
- For review-ready delivery run root typecheck and full tests plus full GUI tests on isolated macmini-cf checkout; build locally for rendered proof. Existing PR gates already fail before this patch: diagnose separately and do not claim green by inheritance.
- Browser smoke at 1440px and 390px, light/dark, English/Korean: inspect screenshot, actual hyperlinks and keyboard focus, note editing and overflow. No live account data or upstream inference.
- Preserve both original histories: build on sponsor remote heads in this bound worktree with separate local branches, carry shared commit to second branch, push fast-forward to each existing remote after refreshing identity. No native stack changes.

## Audit and evidence

Independent audit: GO-WITH-FIXES, one blocking coverage gap. Folded: the browser integration smoke must load the real Providers → Details → Overview chain with delayed catalog resolution, assert sponsor content appears, count the shared preset request, then change the fixture endpoint and verify the strip disappears. Component-only screenshots do not close this row. Branch matrix: Orca API/OAuth positive and Packy absent on Orca head; Packy positive and Orca strip absent on Packy head. Baseline focused tests: 13 pass / 0 fail. Existing CI failure is French modal.badge.sponsor untranslated; correct the sponsor-specific locale value while updating copy.
