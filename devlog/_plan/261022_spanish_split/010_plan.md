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

## Consolidated language and contract review, October 24

The contributor authorized corrections after a read-only audit of the completed
[CodeRabbit review](https://github.com/lidge-jun/opencodex/pull/7559#pullrequestreview-5636437341).
Its eleven inline findings and two outside-diff findings are addressed together:
native-context activation and trial wording, the Droid bridge limitation,
code-mode tool names, architecture metadata, live/offline CLI management,
cleanup preview behavior, catalog-refresh exit codes, empty effort lists,
current bundled Bun, the localized signing-policy link, and log scan limits.
Both files reported for missing final newlines were confirmed and corrected.

The service-install caution was checked against `src/service/cli.ts`,
`src/service/orchestration.ts` and `src/service/health.ts`: installation stops
the tracked standalone listener before loading the managed service, then probes
the installed service port. English and Spanish now explain that handover and
show a post-install service-status check. This documents existing behavior.

Read CodeRabbit's official [command reference](https://docs.coderabbit.ai/reference/review-commands),
[configuration reference](https://docs.coderabbit.ai/reference/configuration),
[path instructions](https://docs.coderabbit.ai/configuration/path-instructions)
and [pre-merge checks](https://docs.coderabbit.ai/pr-reviews/pre-merge-checks).
The repository uses the assertive profile and disables automatic Draft review.
Keep those settings intact. Add useful docstrings to the changed localization
and parity helpers instead of suppressing coverage checks. Publish one
consolidated update and request one full review, rather than triggering reviews
on a sequence of partial pushes. A full review is not an exhaustive guarantee.

Merged current `dev` at `26598df2c4c07d781e344ac6119953fed77ecb27`,
preserving the complete upstream test-layout roster and this branch's docs shard.
Spanish now includes JEV pin-editor validation, Qoder provider-only catalogs and
replay-envelope refusal, connected-client stop preservation, account-slot
identity and headless listings, safe subagent limit conversion, edited-value
ownership, the native context-window override, Kimi K3.1 pricing and the
display-only Business Premium capacity weight.

The broader pass examined every page's metadata, ran command/identifier/link
parity across all 74 canonical paths, checked negation candidates against their
English paragraphs, and reviewed operational contracts in the affected guides.
It corrected literal mistranslations in model names, protocol terminology and
negative conditions, plus unclear recovery and cost-limit wording. Only the
two current-bundle statements in each Windows-memory guide changed version;
historical Bun observations remain historical. A manifest-derived regression
now covers those statements to prevent the same version drift.

Frozen installs, typecheck and structure checks passed. The expanded docs,
layout, hygiene, routed-agent, CLI-export, combo-target and service-preflight
group passed 556 tests with 5,043 assertions across 23 files. The direct
file-size-ratchet command passed; its first test scan exceeded 120 seconds
(8 passed, 1 timeout). The separate retry after the build passed all 9 tests
(85 assertions; repository scan 611 ms), without modifying a cap. Final Spanish
parity and CLI combo-file validation passed 68 tests (2,304 assertions); the 15
Spanish cases overlap the first group, while the 53 combo cases are additional.
The build completed with 667 pages, 97,690 checked internal links, Pagefind and
sitemap. All nine landing locales were checked for an existing localized
signing-policy target or the canonical fallback, retaining the required signing
attribution. The full-root-suite resource exception remains explicit; no
old-head CI is presented as validation of this update.

Actual-browser inspection confirmed the Spanish signing-policy navigation,
1280px landing and policy layout, 390px native-context rendering and mobile
navigation without page overflow, and 41 Spanish Pagefind results for context.
Fresh screenshots are published on the separate `pr-assets` branch, not this
source branch. The inspection also found and corrected the hero's accessible
English conjunction and untranslated beta announcement.

Federico's human Spanish acceptance was recorded on the preceding published
head. The current correction is not a claim that he executed a new browser or
native Desktop test. Keep the fresh-review and maintainer-acceptance gates open
until their actual outcomes are available.

## Final upstream refresh and verification, October 25

Before publication, `dev` advanced another 25 commits. Merged
`8ebe46b2076445d100cef1e52af4d98d78f8f1e1` without conflicts and retained the
upstream layout shards. Synchronized the nine changed canonical pages:
contribution/test-runner guidance, hard-lock candidate inspection, Hermes named
profiles and marketplace detection, Moonshot K3.1 seeds, Pi startup failures,
native citation projection, expected-Home sync flags, Kiro overage refusals,
and response-download backpressure. The test runner pin is now Bun 1.4.4,
matching the shipped runtime; the Spanish contributor version is covered by
the manifest-derived regression. Also clarified Kimi cache-key rejection,
effort-only LazyCodex saves, and identical-catalog no-op behavior.

Final frozen installs changed no dependencies. Typecheck and structure checks
passed. Under the current 1.4.4 pin, the focused docs/layout/CLI/service group
passed 611 tests (5,218 assertions, 24 files). Eight additional relevant runtime
files passed 181 tests (3,465 assertions), including Hermes profiles, guarded
sync, Kiro, native compact and pinned HTTP. After the final prose edits, the
Spanish and Bun guards passed 18 tests (2,155 assertions), overlapping the first
group. The first file-size repository scan exceeded 120 seconds (8 passed,
1 timeout; 172 seconds observed in the case). The direct ratchet command
passed, then an isolated retry passed all 9 tests (85 assertions; repository
scan 447 ms), without a baseline or cap change. These results cover 801 unique
focused cases; they do not claim a full-root-suite result or establish the
cause of either earlier scan timeout.

The final offline build completed with 667 pages, 97,705 checked internal links,
Pagefind and sitemap. Actual-browser inspection checked the newly synchronized
Hermes and expected-Home sync sections at 390px and recaptured the Spanish
landing at 1280px. The browser viewport was restored afterward. The additional
captures are on the fork's separate `pr-assets` branch at
`73c6b4592d0bd103c9717d049a0c6020b0321dd9`, under `spanish-docs-20261025/`;
no image is added to this source branch.

Publish the correction commits together, document staged privacy validation,
resolve the eleven corrected inline threads, and request one full review.
Do not wait for CodeRabbit's result. The full-root resource exception,
authorized current-head CI, requested manual `lane=all`, and maintainer
acceptance remain explicit gates; the PR stays Draft.

## Consolidated review correction, October 26

The contributor authorized correcting the eight new inline findings from the
completed CodeRabbit review of `8400645a26c36520f5df33ece80c8f49ed0c47b5`.
Merged 33 newer `dev` commits through
`81ce59591c06b2f1bde71748588fda69078662a2` (2.93.0), preserving history in
`f462c6907a898dc5a324a1032043daf923d48828`. The only conflict appended both
the upstream combo shard and this contribution's docs shard. The resulting
roster, all upstream shard contents, and the expected fixture roster were
compared with upstream; no upstream entry was dropped.

The eight corrections cover prompt-base replacement, separate foreground Hub
and dashboard terminals, Stop ownership/refusals, cost coverage, proxy precedence,
sidecar save/apply receipts, Advisor failure/retry behavior, and manual Desktop
update instructions. English is clarified where it also obscured existing
behavior; the two-terminal correction is applied across all nine physical
documentation locales. No runtime or CI policy is changed by this contribution.

The cost explanation was verified against `src/usage/summary.ts` and its cost
regressions. A known-zero-spend refusal is not unknown potentially billed work;
it does not make a subsequently measured attempt unpriced. A row consisting
only of known-zero refusals contributes no measured request fact, and a summary
containing only those rows is unmetered. A cancellation or unmeasured upstream
attempt can still be potentially billable. The updated prose preserves these
distinct cases rather than treating every failed request alike.

Reviewed the complete prompt-layer and Advisor guides against current English
and the relevant runtime. Corrected additive layers versus replacing variants,
account attribution, repair/ownership, cached skill catalogs, unquoted JSON keys,
consultation deduplication, and task continuation after an unavailable preflight.
Actual-browser inspection also exposed mistranslated Remote Workspace grant,
prompt-acceptance, hard-link, ordered-message and containment language. Rechecked
that complete guide against English, retaining all commands and identifiers.
Escaped the English and Spanish `<default>` labels so their text renders instead
of being interpreted as HTML.

Synchronized the 18 canonical pages changed by the new upstream commits. Spanish
now includes Flex selection, opt-in combo cooldown reprobes, JEV Decisions
validation, Qoder/WorkBuddy homes and admission, provider seed repairs, MiniMax
retirement, Antigravity Chat limits, literal SSH Include paths, retired OpenCode
sidecars, restart handover, native compaction/tool rules, WebSocket liveness,
effort floors, Cursor globs and Windows launcher/update process-tree behavior.

The existing docs guard now exercises separate foreground/GUI blocks in all
nine locales. Its code-span scanner correctly treats backslashes inside code
spans as literal, including a trailing-backslash path followed by identifiers.
The regression rejects an altered later identifier while preserving escaped
prose openers. This follows CommonMark 0.31.2 section 6.1; the helper remains a
technical-parity scanner, not a general Markdown parser. All 74 paths retain
command-block and inline-identifier parity.

Frozen root, GUI and docs installs passed without lockfile changes. Bun 1.4.4
matches the test/runtime pin. Typecheck, structure and the direct file-size
ratchet command passed without changing a cap. The isolated wrapper was used
for all tests:

- Docs/layout/structure/hygiene/CLI group: 536 passed, 0 failed, 4,803 assertions,
  21 files. This includes all `docs-*.test.ts` guards, both layout tests,
  structure-ssot, ci-structure-gate, repo-hygiene, cli-export-command,
  cli-combo-set-targets and cli-combo-parity.
- Advisor/agent/cost/service/update group: 580 passed and one Windows fixture
  failure, 4,185 assertions, 25 files. The failure is `advisor-budget.test.ts`
  "a symlink is refused before SQLite can mutate its target": Windows returned
  EPERM while `symlinkSync` created the fixture, before the behavior under test.
  The test and implementation match upstream; neither was changed or skipped.
- Current-dev runtime group: 533 passed, 8 skipped, 0 failed, 5,145 assertions,
  20 files. It covers Flex, cooldown reprobes, JEV, client homes, provider seeds,
  Cursor globs, required tools, compaction, WebSocket liveness, the CLI launcher,
  sidecar usage and Antigravity Chat. The eight existing Windows skips cover
  Cursor symlinks, POSIX SSH Include escaping and six PATH-based Bun cases;
  those platform branches remain for authorized Linux/macOS CI.
- Re-ran the unchanged Advisor budget file on Linux using official Bun 1.4.4
  image `oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`:
  4 passed, 0 failed, 13 assertions, including the symlink refusal. The disposable
  container had no network, a read-only checkout and a private temporary
  filesystem; no Windows permissions or personal configuration were changed.
  Three cases overlap the Windows group, so these are not four new unique cases.
- The final docs/layout group above was rerun after the last prose and scanner
  regression edits; it includes the Spanish and Bun guards. An earlier isolated
  recheck passed 20 tests with 2,188 assertions, overlapping that group.

The exact reproduction commands and final build, browser and staged privacy
receipts are included in the PR description. The full-root-suite resource
exception remains: this turn does not claim a passing full root run, and the
preceding combined-PR 900-second run included failures not all classified as
environmental. The unexecuted remainder and cross-platform coverage still need
authorized exact-head CI and the maintainer's requested manual `lane=all`.

CodeRabbit reported 100% docstring coverage on the preceding head, but its
LanguageTool check did not cover everything because the organization's local
character budget was exhausted. The manual language/contract pass and parity
tests do not turn that into an exhaustive grammar-tool success. Keep that
limitation and fresh review separate from contributor language acceptance.

The final offline build completed with 667 pages and 97,816 checked internal
links, including Pagefind and sitemap. The built nine-locale signing-policy and
attribution check passed. Actual-browser inspection at 1280px verified the
prompt-variant replacement warning and visible `<default>` label; at 390px it
verified the two-terminal Hub setup and Advisor failure guidance. These pages
had Spanish language metadata and no horizontal page overflow. The Spanish
Pagefind query `asesor` returned 12 results and its Advisor result opened the
Spanish guide. The viewport was restored afterward; the preview remains at
`http://127.0.0.1:4323/es/`. Native Desktop was not exercised, and personal
Desktop port 10100, credentials and configuration were not used.

Four fresh screenshots are on the fork's separate `pr-assets` branch at
`0a6e2aae19a79947362eb1530eb84b120addbcc1`, under
`spanish-docs-20261026/`. None is added to this source branch. Rechecked upstream
before publication: the branch contains the fetched current `dev` tip.
Publish the consolidated source update, resolve only the eight corrected
threads, and request one full review without waiting for it. Keep Draft until
fresh review, authorized exact-head CI and maintainer acceptance are recorded;
historical contributor language acceptance is not a new human or native test.

## Consolidated review correction, October 27

The contributor authorized resolving the latest pending review. The completed
CodeRabbit review of `c5d9b720ba518f761127855c10da1aa65f77a1f7` supplied ten
inline findings and one outside-diff finding. All eleven are addressed together:
the separate Hub data/management origins, quota freshness, account selection,
replay-429 diagnostics, conversation-link normalization, provider generation
tests, Ollama tool rules, the exact `AdapterEvent` symbol, signing fallback, and
synced-folder detection. The outside-diff log-filter finding belongs to
`reference/cli/agents.md`, as its explanation states, rather than the path in
the generated heading; English and Spanish now document stderr and exit 2 for
usage errors versus stderr and exit 1 for operational failures.

Preserved published history while merging 29 upstream commits through
`4118b90ba40076c62af66fd922421943204bb041` (2.94.0) in
`e0f3e246acbadb9aedfe56afcfddab248bc38392`. A final fetch found two more commits;
merged through `95cfa30ec72f201818b1c80ff9b03fe70c7a8a0e` in
`5b173a202026b7d15481ac1f144fbff329fab1d8`. Both layout conflict resolutions
retain every upstream entry and all eleven upstream shards, appending only
this contribution's docs shard. The expected fixture roster was checked
against upstream after removing only the additional Spanish-docs entry.

Synchronized the fifteen canonical pages changed by those upstream commits.
Spanish now covers GPT-6.1 Terra's distinct native/API limits, context choices,
reasoning capabilities, Qoder image admission, provider seeds and verification
limits, Hermes refresh ownership, direct-account credit metadata, combo reprobe
reservations, checkpoint authority, Claude tool loading, the confirmed POSIX
Codex CLI update jobs, completed-tool relay, Mistral reasoning and Desktop
recovery verification. No backend, GUI, desktop, dependency or workflow
implementation differs from this integration base because of the contribution.

The direct corrections also exposed adjacent mistranslations: a generation
window shorter than one second is unavailable; Ollama Cloud does not enforce
format constraints; non-streaming API callers still receive HTTP 413; and Hub
consent, client-key ownership, disconnection, TLS/Host/Origin checks and service
repair need their existing conditions preserved. These passages were compared
with current English and implementation. Signing fallback is clarified in
English, Spanish and Turkish: an unsigned original remains unchanged, an MSI
keeps its original updater signature if present, and the standalone executable
has no original updater signature. This is documentation of existing behavior,
not a change to signing or authorization.

Corrected the first Hub connection command and the dashboard development
two-terminal recipe across all nine physical locales. The existing Hub guard
now checks each connection example, joining shell continuations before
checking the separate data/management origins. A read-only comparison finds
one invalid first example in each locale on the preceding published head and
none after the correction. The foreground-recipe regression checks both the
Remote Workspace and dashboard guides in every locale. No cap was increased,
test skipped, or upstream test-layout entry dropped.

Frozen root, GUI and docs installs passed. Bun 1.4.4 matches the runtime/test
pin. Final root typecheck, structure check and the direct file-size ratchet
passed. Focused receipts, using repository wrappers and synthetic test homes:

- All docs guards plus layout, structure and hygiene: 470 passed, 0 failed,
  4,882 assertions across 19 files. This final run follows both merges and the
  Desktop guide synchronization.
- Provider completion/quota, Ollama tools, log filters, client connection and
  spend-ledger contracts on Windows: 768 passed, 5 platform skips and one
  fixture failure across 23 files, with 3,092 assertions. The failure is
  `spend-ledger-owner.test.ts` "a dangling journal symlink is refused rather
  than followed": Windows returned EPERM while creating the symlink fixture,
  before exercising the behavior. The test and implementation match upstream.
- Linux storage/startup and signing-policy regressions: 56 passed, 25 skipped,
  0 failed, 303 assertions across 4 files. This covers the Windows-blocked
  symlink case and POSIX identity/hard-link cases. The skips are native
  PowerShell/Authenticode fixtures unavailable in the minimal Linux image.
- Windows signing-policy file: 26 passed, 12 existing platform skips, 0 failed,
  186 assertions. This does not establish real release signing.
- GUI quota freshness/refresh/account and log-filter tests: 93 passed, 0 failed,
  527 assertions across 7 files using the GUI pinned wrapper and synthetic DOM.
- Current-dev contracts: the 19-file Linux group initially passed 511 tests,
  skipped 1 and failed 9 (3,067 assertions) because its temporary mounts were
  non-executable. A direct executable/access probe reproduced EACCES. Rechecking
  only the two affected CLI apply/admission files with executable private
  mounts passed all 50 tests with 1 root-user permission-case skip and 302
  assertions. The other 17 files had already passed 470 tests; these results
  overlap and are not an additional unique 50 beyond that 19-file group.
  Earlier preparation attempts lacked Node/npm or a writable workspace; their
  failing setup logs are retained locally rather than described as successes.
- Latest Desktop recovery contracts on Windows: 82 passed, 8 existing platform
  skips, 0 failed, 505 assertions across 3 files. Compiled native Linux recovery
  and procfs cases remain for the appropriate platform.

Linux storage used official Bun 1.4.4 image
`oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`.
CLI apply additionally used Node 24.22.1/npm 11.19.1 from
`node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`,
with the same Bun copied into a disposable image. Network was disabled; the
checkout was mounted read-only, and the explicit source copy, private npm
prefixes, homes and temporary files lived only in container tmpfs. No personal
installation was updated or tested, and no host permission was changed.

All 74 canonical paths retain command-block and inline-identifier parity.
The final build completed with 667 pages and 97,927 checked internal links,
including Pagefind and sitemap. Built locale signing-policy links and
attribution also passed. Actual-browser review checked the Hub connection,
provider generation contract and current model guidance at 1280px, and Hub and
Desktop guidance at 390px. Spanish metadata was present and the inspected
pages had no horizontal page overflow; long code remains internally scrollable.
Pagefind returned 15 results for `Terra`, and its GPT-6.1 Terra link opened the
Spanish provider guide. The viewport was restored after review. Native Desktop
was not exercised; personal port 10100 and personal configuration were untouched.

Four screenshots are on the separate `pr-assets` branch at
`4789fc6f3a797341b6d5c4929fe4329b7b5a9b7b`, under
`spanish-docs-20261027/`; none is on the source branch. The exact commands,
staged privacy result and published source SHA are recorded in the PR body.

The full-root-suite resource exception remains: no passing full root run is
claimed, and the earlier 900-second run had failures not all classified as
environmental. Focused success leaves the remainder, skipped native cases and
cross-platform coverage for authorized current-head CI and the maintainer's
requested manual `lane=all`. Adding `ci:full` through the connector was denied
with HTTP 403; no alternate credential route was attempted. The existing
fixture-path selector should independently choose the full Ubuntu lane for
this PR's fixture diff, subject to maintainer authorization. No CI policy is
changed. After publishing, resolve only the ten corrected threads and request
one full CodeRabbit review without waiting for its result. Keep the PR Draft
pending fresh review, authorized CI and maintainer acceptance. Historical
contributor Spanish acceptance is retained, not recast as a new human test.

## Readiness refresh, October 29

The contributor authorized closing the actionable pending work after a read-only
audit. Fast-forwarded the clean checkout to the maintainer's published
`f074adb71c631b057ef375dbf683ed3e5b3bd14f`, retaining the ordinary carry merges,
their Spanish corrections and attribution. Merged 49 newer dev commits through
`3ea89653f5727aea41948ddbd5e833f74afe3e36` (2.95.0) in ordinary merge
`fae2396a53a066dbe05d31d49131f304cb57f618`. Before publication a fresh fetch still
reported that same tip and zero missing dev commits. No history was rewritten.

Resolved four merge conflicts: the configuration sidebar retains Catalog with
Spanish copy and every upstream entry; landing and JSON-LD retain the new
gateway wording and locale registration; the test layout retains all 19
upstream shards plus this contribution's docs shard. Compared the normalized
layout with upstream after removing only that shard, verified every upstream
shard, and compared the expected fixture map after removing only the added
Spanish-docs test entry. None was dropped.

Spanish now covers all 78 canonical paths, including the new LM Studio strict
template, catalog omission and Windows ACL-timeout pages. Updated the changed
quickstart, Claude Desktop model visibility, constrained tool translation,
native model omission, context-overflow failover, Advisor caller policy,
provider/model batch probes, Kiro IAM login, Moonshot migration, xAI includes,
Opus thinking display, SSH recovery and keyless CC-Switch import. The previously
separate #7770 is now in dev, so its `completeOnMaxOutputTokens` setting is
included with the same default and exclusions as English. Added the new
Spanish runtime-evidence strings and regenerated the client support matrix with
the owning command; no other locale output changed.

The shared landing-key contract now compares complete Spanish and French key
sets and verifies every visible/accessibility call. It found missing labels
from the upstream landing refresh; all are translated. Kept the French drum
accessibility label while adopting the new copy. Browser review also confirmed
that the full search pill crowded the brand at desktop widths: its name had an
81px text box for 127px of content. At intermediate widths the header now uses
the existing 44px accessible search button without its decorative label/shortcut,
reserves the brand and reduces gaps. At 1160px and 1280px the complete 127px
name fits, without page overflow; clicking search and opening a result still
works. Mobile keeps its existing controls. No runtime or CI behavior is changed.

Frozen root and docs installs passed with Bun 1.4.4. Root typecheck passed for
2,243 files; structure check and direct file-size ratchet passed. Validation
used the isolated repository test wrapper and synthetic data:

- The 20-file docs/client-matrix/layout/structure/hygiene batch initially had
  490 passes and two failures (5,462 assertions). The remaining failures identified
  provider-role prose that did not name single-leading-system compatibility and
  combined two role cases. Corrected the documentation, preserving the tests.
  The final two affected files passed all 48 tests, 0 failures, 2,499 assertions;
  46 overlap the original batch. All selected cases are accounted for; this is
  not a claim that the initial batch exited successfully. The new landing-key
  check also caught omitted labels before this final run.
- The 14-file current-dev runtime-contract batch had 456 passes and two Windows
  fixture-cleanup failures, 3,100 assertions. Both failures were EBUSY from
  removing temporary SQLite fixture directories in `cc-switch-import.test.ts`.
  A focused rerun of F1/F2 and F3 passed F1/F2 but retained the F3 cleanup failure
  (1 pass, 1 fail, 7 filtered out, 98 assertions). No assertion or timeout was
  weakened and the test/runtime source is unchanged from upstream.
- Ran the unchanged full CC-Switch file on Linux: 9 passes, 0 failures, 545
  assertions, including F1/F2, F3, WAL/hard-link and FIFO cases. The disposable
  Bun 1.4.4/Node 24.22.1 container had no network, a read-only checkout and an
  explicit private source copy, configuration and prefixes in temporary memory.
  The Windows cleanup limitation remains disclosed; Linux does not establish
  that Windows cleanup passed. These cases overlap the Windows batch.

All 78 pages retain technical command/inline parity. Final docs build: 703 pages
and 104,154 internal links, including Pagefind and sitemap. Actual-browser
inspection covered the Spanish homepage on desktop/mobile, LM Studio at desktop
width, the new catalog reference on mobile and the Windows ACL page through
search. The compact search found one Spanish result for `icacls` and opened the
new Spanish troubleshooting page. Inspected pages had Spanish language metadata
and no horizontal page overflow. The viewport was restored; the isolated static
preview remains at port 4323. No personal Desktop state or port 10100 was used.

Four screenshots are pinned on the separate `pr-assets` branch at
`2a461766e22f3aaad57f873a10fe420553484468`, under `spanish-docs-20261029/`.
No screenshot is on this source branch. The PR description records final staged
privacy validation, commands, the published head and exact-head CI status.

Keep the full-root resource exception and unexecuted native-client/platform
coverage explicit. Independent final Spanish/render acceptance is the separate
maintainer-arranged gate requested in the October 28 triage; this implementing
agent's inspection and the contributor's historical acceptance do not replace
it. The current policy treats `lane=all` as a batched dev check, not a per-PR
gate; do not request or dispatch it again for this branch. The fixture-path diff
should choose the full Ubuntu PR lane when CI is authorized. Publish once,
update the description once, request one full CodeRabbit review without waiting
for its result, and leave Draft pending independent acceptance and current-head
CI. Do not merge or change CI permissions, labels or workflows.

## 2026-10-29 — Windows CC-Switch fixture cleanup

Reproduced the reported F3 cleanup failure on Windows with Bun 1.4.4, using the
repository wrapper and a dedicated ignored TEMP root. The unchanged case reached
all 15 assertions but failed its teardown with EBUSY after the 15-second removal
budget. Its uncached SQLite prepared statements survived the default deferred
connection close. F1/F2 used the same deferred-close pattern.

Those two fixtures now use `Database.close(true)` to finalize outstanding
statements and release file handles before unlinking the hard-link alias or
removing their temporary home. The outer F3 finally also uses that idempotent,
strict close instead of swallowing close failures. The shared removal helper,
retry budget, assertions and test-home protections are unchanged. The owning
`structure/ops/test-sandbox-cleanup.md` contract records this lifecycle.

Validation, from the repository root with `OCX_TEST_RUNNER_BUN` pinned to the
installed Bun executable and TEMP/TMP contained under the ignored task scratch:

```powershell
bun scripts/test.ts --timeout 120000 --test-name-pattern 'F3:' tests/providers/cc-switch-import.test.ts
# Before the fix: 0 pass, 1 teardown failure, 8 filtered out, 15 assertions.
bun scripts/test.ts --timeout 120000 tests/providers/cc-switch-import.test.ts
# After the fix: 9 pass, 0 fail, 543 assertions; F3 completed in 164 ms.
bun scripts/test.ts --timeout 120000 tests/cli/cli-provider-cc-switch-import.test.ts tests/lib/remove-tree-helper.test.ts tests/ci-workflows/test-home-guard.test.ts tests/ci-workflows/test-home-guard-unpreloaded.test.ts tests/ci-workflows/test-temp-quarantine.test.ts
# 50 pass, 6 existing platform skips, 0 fail, 278 assertions.
bun run typecheck
# Zero type errors across 2,243 files.
bun run structure:check
bun scripts/file-size-ratchet.ts
git diff --check
# All passed.
```

The full root suite was not rerun for this fixture-only resource-lifecycle fix:
focused red/green reproduction, the entire affected file, related CLI and
home/removal guards cover the change without repeating the costly runtime suite
on the shared host. Broader hosted/platform coverage remains subject to the
maintainer's current-head PR CI approval. No production runtime or Desktop file
changed, no real credential or client configuration was imported, and the
Desktop listener remained on 127.0.0.1:10100 in the same observed process.

This follow-up resolves the Windows cleanup limitation recorded above. It does
not resolve the 20 new documentation threads from CodeRabbit's completed review
of `9af015348`; those findings and independent Spanish/render acceptance remain
separate. Keep the PR in Draft and preserve the existing CI dispatch policy.

## 2026-10-29 — Complete the twenty new documentation findings

Reviewed all twenty open threads from the completed CodeRabbit review of
`9af015348`. The branch retains the Windows fixture fix in `eab49f9ad` and all
maintainer carry commits. A fresh fetch found no commits missing from `dev`
(`3ea89653f5727aea41948ddbd5e833f74afe3e36`, 2.95.0).

| Finding | Correction |
| --- | --- |
| 1. Platform Support | Use a Starlight slug; navigation keeps the selected locale. |
| 2. Workflow revision | English and Spanish contributing/PR-quality pages describe the PR merge ref and pre-merge effect, subject to filters and fork approval; trusted default-branch gates remain separate. |
| 3. Activation | State the default-off opt-in and quota-window reset trigger; preserve process-restart recovery and retry timing. |
| 4. Installation | Distinguish the loopback root URL from non-loopback provider-table authentication. |
| 5. Log Guard | Limit filtering to rows persisted in local SQLite; preserve the listed exclusions. |
| 6. Quota privacy | Separate outbound quota signals from bounded local tier counts and selected tier; retain the no-account-ID/token/fingerprint guarantee. |
| 7. Combo options | Add the cooldown-reprobe options to both English and Spanish summaries. |
| 8. Cursor | Describe the selected Claude provider's default reasoning effort, without implying a provider change. |
| 9. Integration removal | State that edits can lock the switch and refuse Disable, leaving the managed block intact. |
| 10. Trace location | Name the actual Logs dashboard section. |
| 11. Executor pairing | Synchronize all nine locale recipes: silent input, stdin delivery, variable cleanup and agent launch only after successful pairing. |
| 12. Subagent roster | English and Spanish describe the first five priorities, non-allowlist semantics and catalog completion. |
| 13. Incomplete usage | Distinguish the warning from readable-only counts/dates/rankings and retain the incomplete-snapshot refusal/recovery. |
| 14. Native omission | Correct both English and Spanish defaults: absent/false/invalid values add no omission. |
| 15. Strict effort | Use the intersection of known effort scales, including empty scales; keep adaptive and dispatch distinctions. |
| 16. API-key scope | State that decision-destination scopes are enforced before credential or request-state reads. |
| 17. Migration | Clearly preserve parsing of old usage rows without routeDecision and explain index rebuilding. |
| 18. Non-loopback credentials | Include configured client API keys in English and Spanish, matching assertServerAuthConfig. |
| 19. Encrypted task recovery | English and Spanish describe the eligible recovery exception and retain the last native error after native attempts; link the existing trust/loopback/no-persistence restrictions. |
| 20. Video Bridge | Align the remaining seven locales with the English/Spanish environment-key reference and explicit key mode; also repair the Japanese example's translated JSON property. |

No runtime, GUI, Desktop, workflow, dependency or lockfile change is made by this
batch. The primary GitHub Actions event reference confirms the merge-ref
distinction; provider, quota, admission and recovery claims were compared with
their current implementations and canonical guides.

Two new regressions inside the existing Spanish-docs guard check that every
locale's Video Bridge example parses and requires the environment key/key-auth
shape, and that every Executor example reads silently, uses stdin and clears
its variable. Both failed before the corrections. The first full docs selection
had 392 passes and one failure caused by a changed inline code-span delimiter in
the effort table. The delimiter was restored without weakening the guard; final
affected-file validation passed all 20 cases and 2,542 assertions. The other
fourteen files' 373 passes remain valid and were not rerun on unchanged inputs.

```powershell
$env:OCX_TEST_RUNNER_BUN = (Get-Command bun).Source
$docsTests = @(rg --files tests/ci-workflows -g 'docs-*.test.ts')
bun scripts/test.ts --timeout 120000 @docsTests tests/ci-workflows/client-support-matrix.test.ts
bun scripts/test.ts --timeout 120000 tests/ci-workflows/docs-spanish-localization.test.ts
bun scripts/test.ts --timeout 120000 tests/routing/jev-quota-signals.test.ts tests/routing/jev-decision-destination.test.ts tests/server/agent-task-recovery-combo.test.ts
bun run typecheck
bun run structure:check
bun scripts/file-size-ratchet.ts
git diff --check
```

The runtime-contract selection passed 46 tests / 270 assertions. Typecheck passed
2,243 files with zero errors. Structure and size gates pass without increasing
any cap. Frozen docs-site install changed no package; the final offline docs
build completed with 703 pages and 104,174 checked internal links, Pagefind and
sitemap. The full root suite was not rerun for this documentation/data-read
change on the shared host; focused docs, semantic runtime contracts and the full
site build cover this batch, with broader hosted/platform evidence left to
maintainer-authorized current-head PR CI.

Six isolated shell smoke cases exercised the actual canonical Bash and Windows
PowerShell snippets with a stubbed ocx command: success and failure, stdin,
absence of the synthetic code from arguments/output, variable cleanup and agent
gating. The checks used private temporary homes, no live pairing, no network and
no execution-policy changes. These are agent-run fixtures, not native-client or
provider acceptance.

Actual-browser inspection verified the corrected catalog text, clicked Platform
Support and reached the Spanish page with lang=es at 1280 px, and inspected
Executor pairing at 390 px without horizontal page overflow. Viewport overrides
were reset. Captures are kept outside the source branch under
`spanish-docs-review-20261029/` on pr-assets, with their pinned commit in the PR.
This does not replace the maintainer-arranged independent Spanish/render
acceptance. The personal Desktop listener remained on 127.0.0.1:10100 in the
same observed process; its configuration and credentials were not used.

Publish the corrections once, then resolve the twenty corrected threads and
request one full CodeRabbit review without waiting for its result. Keep Draft
pending independent acceptance, current-head CI and maintainer review. Do not
merge, dispatch batched CI, change permissions/labels or infer an approval.

## 2026-10-30 — Consolidated audit and seven review findings

Merged the 37 newer dev commits through
`3cab4a74e4eec15ee5ff3bdd59dcab8ede938372` (2.95.0) in ordinary merge
`563de9172d93021fed7d3a41816104efb4b74db7`. The two conflict resolutions keep
all 20 test-layout shards, both new upstream test registrations, and both the
subagent priority explanation and the new workflow-limit panel. Contributor
history, maintainer carry commits and attribution are preserved. A fresh fetch
before publication found zero missing dev commits.

| Open review | Disposition |
| --- | --- |
| Bun roles | Name the test runner and distributed runtime explicitly; their independent checks remain separate. |
| Provider-key examples | Pass literal environment references in all nine Agent Quickstart copies and English/Spanish JEV examples. Explain proxy startup, CLI resolution and separately configured service environments. |
| macOS uninstall | English and Spanish say to remove the managed terminal command before trashing the app; retained state and separately installed services are still identified. |
| OpenCode transport | All nine copies show manually configured HTTPS, explain the required TLS frontend and loopback-tunnel alternative, and retain the dedicated admission header. Seven older Grok copies now carry the same protected-transport and token-file instructions. |
| Remote Hub diagnostic | Label unauthenticated curl as transport-only; browser acceptance still requires an allowed signed-in identity. Matching executable comments are synchronized across locales. |
| Malformed enrollment journal | Say commands are rejected, preserve the original bytes and recovery instructions, and clarify exit 3, temporary-file cleanup and messages already in transit. |
| Windows signing | English, Spanish and the existing Turkish page distinguish attempted production signing from the original unsigned-file fallback. No signing or release policy changes. |

The audit covers the entire Spanish content inventory mechanically: all **79**
canonical paths, executable blocks, inline identifiers and model names,
frontmatter, external references, API status codes, local links, locale maps,
metadata and benchmark placeholders. A numeric-prose comparison and semantic
pattern sweep supplemented manual English/source checks in affected and related
workflows. This is not an independent line-by-line linguistic acceptance of
every sentence or a live execution of every documented integration.

Spanish now follows the new keychain chapter and its sidebar entry, task workflow
ceilings, Artificial Analysis role tiers, launcher verification, Claude agent
cleanup, Meta/xAI/Azure tool and include handling, model-label routing exception,
history-index validation and update-restart refusal. Additional confirmed wording
fixes restore account failover and affinity, jitter, token refresh semantics,
the absent-management-origin condition, and the distinction between context and
cumulative reasoning-archive storage. Duplicated archive-capacity prose is
removed without dropping the refusal codes or recovery guidance.

The credential findings received a separate read-only source investigation and
one fresh candidate review. No surviving scoped credential-example defect or
compatibility regression was found. The public examples change; runtime,
dependencies, Desktop and CI policy do not. Two new existing-file regressions
failed before correction and pass after it. A whole-tree search found no
remaining shell-expanded `--api-key` example in Markdown documentation.

Validation, Windows and Bun 1.4.4, repository wrapper/preload and synthetic homes:

```powershell
$env:OCX_TEST_RUNNER_BUN = (Get-Command bun).Source
$docsTests = @(rg --files tests/ci-workflows -g 'docs-*.test.ts')
$related = @(
  'tests/ci-workflows/client-support-matrix.test.ts',
  'tests/test-layout.test.ts', 'tests/test-layout-tooling.test.ts',
  'tests/providers/provider-key-store.test.ts', 'tests/providers/opencode-cli.test.ts',
  'tests/cli/cli-provider.test.ts', 'tests/routing/jev-decision.test.ts',
  'tests/server/server-loopback-host-gate.test.ts',
  'tests/config/config-workflow-budget.test.ts',
  'tests/server/server-workflow-budget-settings.test.ts',
  'tests/server/management-workflow-budget-routes.test.ts',
  'tests/lib/workflow-budget.test.ts',
  'tests/routing/codex-role-capability-consent.test.ts',
  'tests/routing/codex-role-capability-redirects.test.ts',
  'tests/providers/cc-switch-import.test.ts'
)
bun scripts/test.ts --timeout 120000 @docsTests @related
# 655 pass, 0 fail; 7,053 assertions across 29 files.
bun scripts/test.ts --timeout 120000 tests/ci-workflows/docs-spanish-localization.test.ts
# Final prose rerun: 22 pass, 0 fail; 2,615 assertions.
bun run typecheck
# 2,252 files; zero type errors.
bun run structure:check
bun scripts/file-size-ratchet.ts
bun run privacy:scan
git diff --cached --check
```

Root and docs-site frozen installs changed no package or lockfile. Final offline
docs-site build, Pagefind and sitemap pass: **712 pages / 105,972 internal links**.
The first post-merge docs selection had 417 passes and five synchronization
failures. A later broad selection had 422 passes and two failures; corrected
prose edits had accidentally omitted adjacent provider details and were narrowed
to retain every canonical identifier/link. The final 655-case selection passed
without weakening assertions. The first build caught missing localized TLS
anchors; those anchors are now explicit and the final build passes. Earlier
failing commands are not described as exit 0.

The full root suite was not repeated on this shared host. This documentation and
data-read change is covered locally by focused docs tests, related credential,
launcher, routing and workflow contracts, typecheck and the complete site build.
The earlier full-run timeout and unclassified failures remain historical limits;
no full-suite pass is claimed. Broader platform, packaged-client and live-provider
acceptance remain for maintainer-authorized current-head CI and human acceptance.

Actual-browser checks inspected workflow-limit table rendering at 1280 px and
the new keychain chapter at 1280/390 px. The mobile page has lang=es and no
horizontal page overflow. Spanish search for “llavero” returned 16 results and
opened the new chapter. The viewport override was reset. Two captures are kept
outside the source branch on pr-assets, with immutable links in the description.
Browser-tool connection failures required a fresh Chrome tab; they were not
reported as product defects. This is agent inspection, not independent native
Spanish/render acceptance. Personal Desktop state and credentials were not used;
its observed loopback listener stayed in the same process during the work.

Publish this consolidated batch, reply to and resolve the seven corrected
threads, update the description once, and request one full CodeRabbit review
without waiting for its result. CodeRabbit's official command documentation
distinguishes a full reanalysis from an incremental review; its configuration
and review scope are unchanged. Keep Draft for fresh review, independent human
language/render acceptance, current-head CI and maintainer integration approval.
