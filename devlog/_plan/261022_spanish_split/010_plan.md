# Spanish localization: split after #7406

## Delivery order

The owner closed #7406 on October 22 because its combined locale changes were
too broad for the review queue and conflicted with dev. The original published
branch stays intact. Recover the contribution in independent branches rooted at
current dev, starting with the documentation site as requested:

1. `codex/spanish-docs`: docs-site Spanish, directly related canonical/translated
   documentation corrections, and the existing documentation regression guards.
2. `codex/spanish-dashboard`: shared Desktop/browser dashboard locale, total
   auxiliary maps, formatting, tests and the dashboard contract.
3. `codex/spanish-readme`: README translation/navigation/manifest and its guard.

Submit the first PR first. Preserve the later branches without opening multiple
review requests at once. Each submission must refresh dev and revalidate its
own diff; a clean merge today does not guarantee compatibility with future dev.

## Documentation base and scope

Initial base: `782655d2317d4c14a99d6db72e9be3368a27886d`, 23 commits after the combined
PR's last integration base. Before submission dev advanced to
`5f7f7db5765c7e99ab2f52c04d9fe0e4ce7608cf`; it was merged and its published
macOS storage-refusal clarification was synchronized in Spanish. Recovered changes use that base's files and retain
its new CLI registration and fallback navigation. The docs branch changes no
dashboard catalog, backend source, dependency, release or workflow implementation.

Spanish covers all 74 current canonical paths, including the new fallback guide.
The refresh includes Remote Link peer versions, Windows refusal/recovery, apply
digests, client restart, service/install JSON and Claude reasoning details.
The sidecar note distinguishes web-search xAI from routed vision in both English
and Spanish. Other latest findings fix product metadata, prose number separators,
the plugin `name` string, and Pi loopback examples in all translated guides.
The timezone-dependent GUI test belongs to the separate dashboard branch.

## Validation receipts

- Frozen root/docs installs: no dependency or lockfile changes. System Bun is
  1.4.4; tests use the required Bun 1.4.3 in ignored scratch space. Its official
  archive SHA-256 was verified against the GitHub release asset digest.
- Root `bun run typecheck`: passed.
- Final Spanish docs after the Pi contract guard: 15 passed, 0 failed (2,126 assertions).
- Structure and privacy scan: passed on staged files.
- Actual-browser inspection: Spanish landing/fallback guide at 1366 px, Pi at
  390 px, localized code controls, no horizontal page overflow, and 17 Spanish
  Pagefind results for fallback. Captures remain outside the source branch.
- Initial Spanish docs and both layout tests: 41 passed, 0 failed.
- All docs guards, structure/hygiene/size and CLI export: 445 passed, one size
  scan timed out while the docs build was running. Isolated size-guard retry
  with `--timeout 120000`: 9 passed, 0 failed; repository scan took 691 ms.
- `OPENCODEX_DOCS_OFFLINE=1 bun run build`: 667 pages and 97,587 checked internal
  links; Pagefind and sitemap completed. Existing unsupported sshconfig
  highlighting falls back to text.

The full root suite is not claimed passing for this branch. The preceding
combined-PR run hit its 900-second limit, with Windows symlink EPERM and timing
failures. This documentation-only split uses the root policy's resource
exception with explicit source-reading guards and exporter regressions instead.
Exact-head upstream CI and independent human language/render acceptance remain
required. No native Desktop acceptance is claimed.

## Review hold

Keep the first submission Draft for owner/localization acceptance. Do not reuse
old CI receipts as validation of a new head. Do not repeatedly request bot
reviews or wait for their completion after publication; the contributor will
inspect the result. Screenshot evidence belongs outside the feature branches.

## PR #7559 consolidated review correction

Reviewed all 36 CodeRabbit threads against canonical English and, for operational
claims, the current service guards, stop path, sidecar settings and CI workflow.
The corrections cover authentication, service repair/restart, search disable and
journal recovery, preview exit codes, adapter contracts and Spanish terminology.
Two suggested premises needed qualification: explicit `ocx stop` stops a managed
service and then restores native Codex; a valid refused preview can exit 0 because
inspection succeeded without applying a change. Neither was changed into the
incorrect behavior suggested by the review wording.

The adjacent semantic pass also restored default-off wording for subagent force,
native subagent defaults, native WebSocket controls and custom context inference.
It checked account/queue/adapter state distinctions and removed unavailable
benchmark-filter instructions from every locale. The current backend, dependency
and workflow implementations remain outside this contribution.

Merged dev at `ec8b8cfac11e8f179c4351f01baa32d76a71dd1b`, preserving both the new
chat layout shard and this branch's docs shard, then at
`9164950d926c770875a267edfeb74183af5caebc` and the docs-only update
`880127dbd356c720779222a14a97c11adc8cf881`. Spanish now includes Desktop
picker-state uncertainty, Antigravity family-quota evidence and the five-slot
`spawn_agent` model-selection rules, including both account-selector cases.

Current validation: frozen root/docs installs, root typecheck and structure check
passed. The explicit docs/layout/hygiene/export/preview/service-auth group ran 588
tests: 587 passed and the repository file-size scan timed out under the parallel
runner. Its isolated retry passed all 9 cases, with the repository scan completing
in 602 ms; no size cap or guard was changed. The root-suite resource exception
above still applies. The final Spanish-doc regression run passed all 15 tests
(2,132 assertions). The final offline site build completed with 667 pages and
97,652 checked internal links, Pagefind and sitemap. Desktop authentication and
service-token sections, mobile sidecar controls, six rendered coding benchmark
boards and Spanish search results were inspected in the real browser. The token
search returned 49 results. Screenshot evidence is pinned outside the source
branch at `588c95e9e636700f2035311017328d5670451e4a` on `pr-assets`.
Privacy scan and diff whitespace checks passed. Keep the Draft and independent
human language/render-acceptance hold; an agent's inspection is not that approval.

## PR #7559 owner-requested refresh, October 23

Addressed the owner's [October 24 UTC triage comment](https://github.com/lidge-jun/opencodex/pull/7559#issuecomment-6378349500).
Merged `dev` first at `2494848f56e8a4f283722b2ebd816977e828c7af`, then at
`ceef4889e4666dc0492a375d272eafa5b785361e` (2.93.0), preserving published history.
All eight upstream test-layout shards remain byte-for-byte identical to that
base; the Spanish documentation shard is appended without dropping any shard.
The provider documentation retains upstream's new Alibaba Token Plan section.

Corrected the remaining nonblank condition in `es/reference/adapters.md`: a
string must contain a non-whitespace character to be converted, while empty and
whitespace-only strings remain unchanged. The existing runtime regression file
checks those cases and exact whitespace preservation. Updated Spanish to match
current JEV session pinning and saved strategies, Antigravity per-account model
availability, provider discovery and credits, Hermes affinity, native effort
normalization, Remote Link readiness/retry diagnostics, and the Bun 1.4.4 runtime.
The landing also translates the new code-signing-policy link while retaining the
required English signing attribution verbatim.

Validation for this refresh:

- Frozen root, GUI and docs-site installs passed; no contribution-owned lockfile
  or dependency changes. Tests use isolated Bun 1.4.3 through `scripts/test.ts`.
- All docs guards plus layout, structure, hygiene, routed-agent conversion and
  CLI-export regressions: 512 passed, 0 failed, 4,661 assertions across 20 files.
- Separate file-size guard: 9 passed, 0 failed, 85 assertions. No cap changed.
- After the final upstream merge, fixture teardown, Codex auth-context and
  server-management-auth regressions: 143 passed, 0 failed, 693 assertions.
- After the final Spanish edits, the Spanish documentation guard was rechecked:
  15 passed, 0 failed, 2,138 assertions. These 15 are already included in the
  512-test group and are not an additional coverage count.
- Root typecheck and structure check passed again after the final upstream merge.
- The offline documentation build checks all 667 pages, internal links, Pagefind
  and sitemap. Final build and staged privacy-scan receipts are recorded in the
  PR's Verification section before publication.
- Actual-browser DOM checks confirmed the corrected adapter paragraph and JEV
  section, Spanish language metadata, mobile navigation, and no page overflow at
  1366px and 390px. The browser screenshot service returned "Unable to capture
  screenshot", including on a fresh tab, so this refresh has no new capture and
  does not claim fresh visual acceptance. Existing captures stay on `pr-assets`.

The documented full-root-suite resource exception still applies. Hosted CI for
the new exact head, including the owner's requested `lane=all`, requires
maintainer authorization. Human Spanish/render acceptance and fresh review are
still pending; keep Draft and do not describe a skipped bot review or an
`action_required` workflow as passing. Request one consolidated CodeRabbit
review after publication without waiting for its result.
