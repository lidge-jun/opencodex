# Lane D recovery verification — 2026-10-03

The six accepted Lane D carries were reviewed at
`da40c734a558ea32ce391613f5a0309d14cfce81`. Focused tests and rendered fixture
scenarios found no demonstrated defect requiring a product-code repair. This
recovery adds only this verification record; it preserves the carries and their
contributor attribution. Final integration CI remains pending.

## Accepted source

| Source PR | Carry commit | Verified contract |
| --- | --- | --- |
| #6426 | `6d4e40443c451039f7d215743aea925852565c49` | Optimistic visibility, ordered writes, reconciliation and target cancellation |
| #6471 | `9d3e6e252a362dd01e756bb48b3af3a75225bf4d` | End-to-end output throughput uses token sums divided by duration sums |
| #6149 | `3e65384642dd6d02d558a425c1a78654cea24ce6` | Compaction source allowlists and conditional conversation disclosure |
| #6151 | `de828619f84659603f6a13740401049f28dd4dde` | Owned Droid defaults, explicit caller precedence and concrete-target validation |
| #6405 | `56ea6d76e36370bc341ec1592a9a290a459942d4` | Effective export metadata and managed OpenCode/Kilo refresh |
| #6458 | `5d7efbb749ffb72efa6696571b73a4a874a8c61d` | Brazilian Portuguese catalog, placeholders and auxiliary locale maps |

All six commits are ancestors of the verified head. The train's existing
Portuguese zoom-key repair is included. No dropped item was revived: #6436
retains its product hold, #6336 retains its credential-destination evidence
blocker, and #5253 remains superseded by #6458.

## Executed verification

Local macOS, Bun 1.4.0. Batches ran sequentially; full outputs were inspected.
The root command uses the repository test preload and sandbox:

```sh
bun test ./tests/usage/usage-throughput.test.ts ./tests/responses/responses-compaction-override.test.ts ./tests/responses/droid-reasoning-defaults.test.ts ./tests/clients/droid-managed-reasoning-defaults.test.ts ./tests/server/management-droid-reasoning-defaults.test.ts ./tests/clients/client-export-effective-metadata.test.ts ./tests/clients/client-export-reasoning-controls.test.ts ./tests/clients/opencode-kilo-refresh.test.ts
```

Exit 0: **144 passed, 0 failed**, 1,175 assertions across eight files; no skips
reported. The GUI command ran from `gui/`:

```sh
bun test --isolate ./tests/models-visibility-queue.test.tsx ./tests/usage-custom-range.test.tsx ./tests/compaction-routing-panel.test.tsx ./tests/integrations-surfaces.test.tsx ./tests/i18n-locales.test.ts ./tests/locale-parity.test.ts
```

Exit 0: **132 passed, 0 failed**, 4,920 assertions across six files; no skips
reported. `bun run structure:check` and `bun scripts/file-size-ratchet.ts`
also passed. Runtime locale tests confirm equal English/Portuguese key sets,
placeholder parity and registration; static extraction counted 3,769 keys each.

## Rendered scenarios

Real source components and production CSS ran through the existing Vite dev
server against fixture-only loopback responses. Vite inherited no proxy config;
unmatched fixture API calls failed closed. The browser used an isolated profile.
No user configuration, credentials, accounts or installed client files changed.

- Models: repeated toggles displayed the latest intent while a write was held;
  request records confirmed click order. Bulk changes reconciled, refused saves
  restored authoritative state, and switching targets discarded the old draft.
- Usage: summary and tables displayed measured throughput and an unavailable
  marker for missing telemetry. This metric is not decode speed.
- Compaction: a 350-model roster rendered a bounded subset. Selecting a search
  result beyond the first 300 retained an existing hidden selection on save.
- Droid: the selected effort reached the review request, refused apply displayed
  an error, and an external target change cleared the draft and confirmation.
- Portuguese: all four views were inspected at 390×844; document width stayed
  within the viewport. Wide tables retained their local horizontal scrolling.

Twelve screenshots were inspected, including English desktop states at 1440×1000.
Screenshots and raw logs remain outside tracked source for the integration review.
Browser execution resumed after fixture-only middleware ordering, searchbox
locator and modal-covered fixture-control corrections; it was not one uninterrupted
passing run. Passing portions were retained without repetition. Both the fixture
server and isolated browser were stopped and their loopback listeners closed.

## Older review dispositions

- **#6149, review5343376705:** `gui/src/i18n/ja.ts:466` and `:469` express retry
  as a possibility. `gui/src/i18n/ru.ts:466` and `:469` identify target providers
  as recipients of the conversation. Tests in
  `gui/tests/compaction-routing-panel.test.tsx:261` and `:271` pin the conditional
  Japanese meaning and both Russian scopes; all three cases passed.
- **#6151, review5341490252:** `src/server/chat-completions.ts:159` preserves the
  default separately from explicit effort before translation; `:452` carries
  that provenance into combo/policy dispatch. Literal validation occurs against
  each target in `src/server/droid-reasoning-default.ts:25`,
  `src/server/responses/core-combo.ts:719`, and
  `src/server/responses/core-combo-native.ts:212`. The regression at
  `tests/responses/droid-reasoning-defaults.test.ts:269` covers both empty and
  incompatible nonempty first ladders across bridge, native and policy routes.
  Ownership fingerprint checks in `src/integrations/state.ts:485` and the
  managed-default tests reject edited or foreign rows. These cases passed.
- **#6426 scope comment:** the carry's English and Chinese dashboard-document
  hunks contain only queue-behavior additions, without unrelated metadata or
  reflow changes. Render evidence supports maintainer UI acceptance review;
  this technical verification is not itself that approval.

An inherited independent final reviewer read both focused logs, checked these
dispositions and fixture isolation, inspected representative screenshots, and
returned **PASS with no blocking findings**. No duplicate rewrite was needed.

## Remaining acceptance

Frozen-union root/GUI typechecks, production bundling and comprehensive
cross-platform CI remain coordinator-owned and pending. No full local suite,
dependency installation, native build or live provider check ran. Fixture page
rendering does not establish authenticated app-shell, packaged Tauri, real
Droid/OpenCode/Kilo wire behavior, or native-speaker Portuguese acceptance.
No security approval, release, deployment or issue closure is claimed.
