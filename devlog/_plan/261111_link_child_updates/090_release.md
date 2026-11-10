# 090 — Release: batch cross-platform CI, Release workflow, published version

> **Revision 2 (audit r1).** Folds M11 (new step 8a prepends a "Remote Link changes" section to the published
> GitHub release body with `gh release edit --notes-file`, keeping the generated changelog, verified with
> `gh release view`; acceptance criterion 8) and L12 (facts re-checked by audit r1 on 61151e3457: `structure:check` exit 0,
> `layout.json` 1998 lines; the version derivation in step 5 must be rerun on the release commit).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529522154 (step 5 assigns `V`, refuses an empty value and prints it)
> and 4529522164 (the Remote Link disclosure ships inside the generated notes the draft is created with: step 0 lands
> `scripts/release-highlights/<V>.md` before `R` is chosen, `build-release-changelog.ts` prepends it, step 5a checks
> the rendered notes before dispatch, and step 8a only verifies; editing a published release becomes a recovery path).

- **Work phase:** wp9
- **Depends on:** wp1–wp8 squash-merged into `dev`, each with green exact-head required CI, a
  fresh independent review, and the explicit security review recorded for wp3 (mutating
  `/api/link/children/*` routes) and wp8 (link-listener write, Desktop updater entry point).
- **Class:** C4 (release automation and publication; `MAINTAINERS.md:83-111`).

**Outcome.** One stable OpenCodex version that contains every phase of this unit is published
to npm under `latest`, as a public GitHub release with the standalone `ocx` archives, the
Desktop installers and their updater signatures, and a `latest.json` that points Desktop
updaters at it. The release is cut from one `dev` commit that has a complete successful
manual `lane=all` run and, because wp8 changes `desktop/**`, a successful service-lifecycle
run. No source file changes in this phase.

**IN:** choosing the release commit, the batch `lane=all` dispatch, the service-lifecycle
dispatch, the Release workflow dispatch with `tag=latest`, `dry-run=false`,
`expected-sha=<R>`, verifying npm, the GitHub release and the Desktop update manifest, the
docs deploy, and recording the outcome.

**OUT:** any edit to `.github/workflows/*`, `scripts/release.ts`, `.github/scripts/*` or
repository settings and variables; a preview release; installing the release on the owner's
Home, Children or this machine (`000_plan.md:32-36`, UNSAFE outcome); the
`desktop-installed-gate.yml` self-hosted gate (maintainer-registered GUI machines only,
`.github/workflows/desktop-installed-gate.yml:1-7`).

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| (none) | — | The release changes no tracked file. Versions are stamped in temporary build checkouts (`structure/ops/docs-and-release.md:406-410`). |
| `devlog/_plan/261111_link_child_updates/` → `devlog/_fin/261111_link_child_updates/` | MOVE (follow-up docs PR, C0) | After publication, record the released version, run ids and outcome in `000_plan.md`, then move the unit to `_fin` (`AGENTS.md`, "The `devlog` directory"). |

## How the release machinery works (verified at 00680193cb)

- `scripts/release.ts:117-156` resolves source evidence with
  `.github/scripts/release-evidence.cjs resolve [sha]`, then runs
  `gh workflow run release.yml --ref dev -f tag=<channel> -f expected-sha=<sha> -f dry-run=<!publish>`
  (:151-152) and watches the run. Publication needs the `--publish` flag (:124); the default is a dry run.
- Release inputs (`.github/workflows/release.yml:5-33`): `tag` (`latest` | `preview`, default
  `latest`), `dry-run` (default `true`), `expected-sha`, `version` (optional expected derived
  version), `resume-after-npm-publish` (default `false`). The workflow refuses any ref but
  `refs/heads/dev` (:68-70).
- Source evidence (`.github/scripts/release-evidence.cjs:158-166`): a `ci.yml` run with event
  `workflow_dispatch`, branch `dev`, `completed`/`success`, `head_sha` equal to the source and
  display title exactly `ocx-ci-v1 lane=all sha=<source>` (the `run-name` at `ci.yml:10`), and
  every job in `CI_JOBS` (:20-30, 44 named jobs including `macos 1/4..4/4`, `windows 1/11..11/11`,
  `desktop shell`, `npm-global <os>`) completed with `success`. The source must be a `dev` ancestor.
- Service evidence: `verify-npm` and `publish` both rerun "Recheck source CI and service evidence"
  (`release.yml:1047-1074`, :1548-1575). If any path between the newest published release tag
  below the new version and the source matches `SERVICE_PATH`
  (`release-evidence.cjs:116`: `desktop/.+`, `src/cli/index.ts`, `package.json`, `bun.lock`, …),
  a successful `service-lifecycle.yml` dispatch for that source is required, otherwise the run
  fails with "Dispatch service-lifecycle.yml from dev for source <sha>". wp8 edits
  `desktop/src-tauri/src/updater.rs`, so this release needs it.
- Version: `scripts/version-line.ts:194-211` derives `max(package.json base, newest stable + patch)`.
  At this base `package.json` is `2.100.0` and the newest stable tag is `v2.100.1`, so a `latest`
  release derives **2.100.2** unless `package.json` is bumped or another release lands first.
  The 004 note "first supporting version >= 2.101.0" (004 D9) is therefore not guaranteed; see
  Deviations.
- Publication hold: the `publish` job step "Require publication hold to be enabled"
  (`release.yml:1602-1610`) fails a non-dry run unless the repository variable
  `OCX_DEV_RELEASE_PUBLISH_ENABLED` equals `true`. It gates **only** the real publication path
  (`npm publish` and everything after it: `attach-release` needs `publish`, :1251-1254). Packaging,
  `verify-release`, `verify-npm` and dry runs run regardless. Read on 2026-11-11:
  `gh variable get OCX_DEV_RELEASE_PUBLISH_ENABLED -R lidge-jun/opencodex` → `true`.
- Outcome rows: `release-outcomes` (:1398-1425, `scripts/ci/release-outcome-report.sh`) writes
  three separate facts to the job summary: GitHub release published, npm version read back,
  dist-tag points at the version. A green run with an unconfirmed row is not a publication.
- Desktop update manifest: Desktop updaters read
  `https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json`
  (`desktop/src-tauri/tauri.conf.json:74-77`); `verify-release` builds it with
  `--require-signatures` (`release.yml` verify step, `desktop/scripts/verify-release-assets.ts:166-200`).

## Steps (copy-paste; run from a checkout of `dev`, never from a feature branch)

Variables used below: `R` = the full 40-hex release commit, `V` = the derived version.

0. **Land the release highlights before choosing `R` (Revision 4, 4529522164).** The Release workflow creates the draft
   with `--notes-file` from `build-release-changelog.ts` (`.github/workflows/release.yml:1597-1600`, `:1836-1837`) and
   publishes that draft (`:1379-1381`), so text that must be public from the first minute has to be in those notes.
   (a) A small wp9 code PR teaches `scripts/build-release-changelog.ts` to prepend
   `scripts/release-highlights/<version>.md` when that file exists for the exact `--version`, and to fail when the file
   exists but the output does not start with its first line; test in the release-notes suite (file present, absent,
   other version ignored). It is release tooling, so it gets the explicit security review (`MAINTAINERS.md:83-111`).
   (b) Compute `V` with step 5's command on the current `dev` head, then a C0 PR adds
   `scripts/release-highlights/<V>.md` holding exactly the section in step 8a. Both merge before step 1, so `R`, the
   `lane=all` run and the release all include them. If step 5 later derives a different `V` on `R`, stop and rename the
   file through another PR (the run is not dispatched).

1. **Confirm the batch is complete.** Every wp1–wp8 PR is merged; nothing from this unit is open.
   ```sh
   gh pr list -R lidge-jun/opencodex --state open --search "head:codex/link-child" --json number,title
   git fetch origin dev && R="$(git rev-parse origin/dev)" && echo "$R"
   ```
   Expected: an empty list. Record `R`.

2. **Dispatch one batch `lane=all` run and one service-lifecycle run for `R`.** One dispatch per
   batch (AGENTS.md "CI policy"; `MAINTAINERS.md:64-73`). Do not dispatch for PR branches, do not
   re-dispatch because `dev` moved, cancel only your own superseded dispatch.
   ```sh
   gh workflow run ci.yml -R lidge-jun/opencodex --ref dev            # lane defaults to all (ci.yml:36-40)
   gh workflow run service-lifecycle.yml -R lidge-jun/opencodex --ref dev -f source_sha="$R"
   gh run list -R lidge-jun/opencodex --workflow ci.yml --event workflow_dispatch -L 1 \
     --json databaseId,displayTitle,status
   ```
   `ci.yml` tests `github.sha` at dispatch time. If the title is not `ocx-ci-v1 lane=all sha=$R`,
   `dev` moved between step 1 and the dispatch; set `R` to the sha in the title (it contains the
   whole batch) and dispatch service-lifecycle for that sha instead. Do not start a second `lane=all`.

3. **Wait for both runs.** One run is about 32 jobs and six runner-hours; macOS jobs can queue
   behind five slots. GOAT threads end the turn and resume on notification; a shell user runs
   `gh run watch <id> -R lidge-jun/opencodex --exit-status --interval 60`.
   - Green: continue.
   - Red: stop. Read the failing job; fix `dev` through a normal PR from this batch; then a new
     single `lane=all` for the new head (AGENTS.md "Batched merges"). Never rerun to green.
   - The same infrastructure failure in three consecutive cycles → BLOCKED (`000_plan.md:49-52`).

4. **Resolve the evidence locally (read-only).**
   ```sh
   GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=lidge-jun/opencodex \
     node .github/scripts/release-evidence.cjs resolve "$R"
   GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=lidge-jun/opencodex \
     node .github/scripts/release-evidence.cjs service "$R"; echo "service=$?"
   gh variable get OCX_DEV_RELEASE_PUBLISH_ENABLED -R lidge-jun/opencodex
   ```
   Expected: `{"sourceSha":"<R>","ciRunId":<id>}`, `service=0`, `true`. Anything else stops here.

5. **Compute the expected version** (so a surprise derivation fails the run instead of publishing).
   ```sh
   git fetch --tags origin && git checkout --detach "$R"
   V="$(git tag --list 'v[0-9]*' | bun -e '
     import { devReleaseVersion, parseVersion } from "./scripts/version-line.ts";
     const tags = (await Bun.stdin.text()).trim().split("\n").filter(Boolean).map(t => t.slice(1));
     const s = [], p = [];
     for (const v of tags) (parseVersion(v)?.prerelease === null ? s : p).push(v);
     const base = (await Bun.file("package.json").json()).version;
     console.log(devReleaseVersion({ base, stableTags: s, previewTags: p, channel: "latest" }));')"
   # Revision 4 (4529522154): every later step reads V; an empty or malformed value stops here.
   printf '%s\n' "$V" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || { echo "version derivation failed: '$V'" >&2; exit 1; }
   echo "V=$V"
   ```
   Run at base 00680193cb on 2026-11-11 it printed `2.100.2` (exit 0). The workflow also unions npm
   versions (`release.yml:131-141`); if they disagree, the `version` input makes the run stop.

5a. **Check the notes before dispatch (Revision 4, 4529522164).** Render the notes exactly as the workflow will and
   refuse to dispatch unless the section leads them:
   ```sh
   test -s "scripts/release-highlights/$V.md" || { echo "missing scripts/release-highlights/$V.md (step 0)" >&2; exit 1; }
   pre="$(mktemp -d)"
   bun scripts/build-release-changelog.ts --version "$V" --dist-tag latest \
     --repository lidge-jun/opencodex --target "$R" --out "$pre/notes.md"
   head -n 1 "$pre/notes.md" | grep -qx '## Remote Link changes' && grep -q -- '--updates notify' "$pre/notes.md" \
     && grep -q -- '--catalog-fanout manual' "$pre/notes.md" || { echo "notes lack the Remote Link section" >&2; exit 1; }
   ```
   The script also fails by itself when the highlights file exists but is not rendered (step 0a), so the workflow's
   own changelog step stops a release whose notes lack the section before any tag, draft or npm publication.

6. **Dispatch the Release workflow with publication.** Either the maintainer script:
   ```sh
   bun scripts/release.ts latest "$R" --publish
   ```
   or, to also pin the version, the equivalent explicit dispatch:
   ```sh
   gh workflow run release.yml -R lidge-jun/opencodex --ref dev \
     -f tag=latest -f dry-run=false -f expected-sha="$R" -f version="$V"
   ```
   Inputs: `tag=latest`, `dry-run=false`, `expected-sha=R`, `version=V` (optional),
   `resume-after-npm-publish=false` (default). A separate dry run first is optional: `verify-release`
   and `verify-npm` already run before `publish` on a real run (`release.yml:1155-1157,1427-1429`).

7. **Read the outcome** of the release run: `gh run view <id> -R lidge-jun/opencodex` and the
   "Release outcomes for V" summary. All three rows must read `published` / `confirmed`.

8. **Verify publication independently.**
   ```sh
   npm view "@bitkyc08/opencodex@$V" version gitHead --registry=https://registry.npmjs.org
   npm view @bitkyc08/opencodex dist-tags.latest
   gh release view "v$V" -R lidge-jun/opencodex --json isDraft,isPrerelease,assets \
     --jq '{isDraft,isPrerelease,n:(.assets|length)}'
   curl -fsSL https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json | jq -r .version
   tmp="$(mktemp -d)" && npm pack "@bitkyc08/opencodex@$V" --pack-destination "$tmp" >/dev/null \
     && tar -xzf "$tmp"/*.tgz -C "$tmp" \
     && rg -c 'link.child-ops/1|link-child-codex-state/1|desktop-update-request/1' "$tmp/package/src"
   ```
   Expected: version `V` with `gitHead` = `R`; `latest` = `V`; `isDraft:false`,
   `isPrerelease:false`, 25 assets (the v2.100.1 set: `latest.json`; five `ocx-V-bun-*` archives
   with `.sha256`; `OpenCodex-V-linux-amd64.deb`, `-linux-x86_64.AppImage`, `-macos.app.tar.gz`,
   `-windows-x64.msi`, each with `.sha256` and `.sig`; `-macos.dmg` with `.sha256`);
   `latest.json` reports `V`; the packed source contains the three feature ids. The last command
   only unpacks a tarball into a temp dir; it installs and runs nothing.

8a. **Verify the Remote Link section in the published body (M11, Revision 4).** The generated changelog lists PR titles
   only, so the A1, fan-out and A5 disclosures come from `scripts/release-highlights/<V>.md` (step 0), whose text is the
   heredoc below. The draft was created with them, so this step normally only runs the final check. The `else` branch
   is a recovery path for a release that somehow published without the section; reaching it is recorded as a defect in
   step 10, never treated as the normal flow.
   ```sh
   notes="$(mktemp -d)"
   cat > "$notes/remote-link.md" <<'EOF'
   ## Remote Link changes

   - **Automatic Child updates are on by default.** A Home on a stable release now updates its idle, eligible
     Home-initiated Children to the Home's own version, one Child at a time, after the Home has served that version
     for 10 minutes (`updates: auto-when-idle`). It never downgrades, retries a failing Child at most three times per
     version, and never retries a version that rolled back. A manual Update from the dashboard or `ocx link update`
     ends any turn currently relayed for that Child; automatic updates wait until it is idle. Turn automatic updates
     off with `ocx link policy --updates notify` (badge only) or `ocx link policy --updates off`, or in the Remote Link
     policy panel.
   - **Catalog fan-out is on by default.** After the Home's model catalog changes, the Home opens a background SSH
     session to each eligible Child and runs its pinned `ocx sync`, so Children stop showing stale context windows.
     Turn it off with `ocx link policy --catalog-fanout manual`. A Codex app-server already running on a Child keeps
     its old catalog until you use Restart Codex or `ocx sync --restart-children`.
   - **Desktop Children install the Home's version.** Once both the Home and an OpenCodex Desktop Child run this
     release, automatic updates include that Child: it installs its own signed Desktop update when that version equals
     the Home's.
   EOF
   if gh release view "v$V" -R lidge-jun/opencodex --json body --jq '.body | contains("## Remote Link changes")' | grep -qx true; then
     echo "Remote Link section already present"
   else
     gh release view "v$V" -R lidge-jun/opencodex --json body --jq .body > "$notes/generated.md"
     { cat "$notes/remote-link.md"; printf '\n'; cat "$notes/generated.md"; } > "$notes/body.md"
     gh release edit "v$V" -R lidge-jun/opencodex --notes-file "$notes/body.md"
   fi
   gh release view "v$V" -R lidge-jun/opencodex --json body \
     --jq '.body | (startswith("## Remote Link changes") and contains("--updates notify") and contains("--catalog-fanout manual") and contains("Desktop Children"))'
   ```
   Expected: the last command prints `true`, and `gh release view "v$V" -R lidge-jun/opencodex --json body --jq .body`
   still contains the generated changelog after the section. The edit changes only the release text: tags, assets and
   `latest.json` are untouched. The `mktemp` directory holds only these three Markdown files.

9. **Deploy docs** (docs-site changes from wp2, wp4, wp6 and wp8 go live only now):
   `gh workflow run deploy-docs.yml -R lidge-jun/opencodex --ref dev -f release-tag="v$V"`
   (`.github/workflows/deploy-docs.yml:4-7`; empty selects the latest stable).

10. **Record the outcome** in `000_plan.md` (version, `R`, CI run id, service run id, release run id,
    docs run id) through a C0 docs PR, and move the unit to `devlog/_fin/`.

## Field chains

None. This phase creates no field, enum value or wire key. The feature ids checked in step 8
(`link.child-ops/1` from wp3, `link-child-codex-state/1` and `desktop-update-request/1` from wp8)
are owned and chained in their own decade docs.

## Tests

No new test file. The release workflow's own guards are the tests for this phase, and they are
already covered: `tests/ci-workflows/release-preflight.test.ts` (publication hold env, :265-272),
`tests/ci-workflows/release-windows-signing.test.ts`, and the evidence resolver's policy
fingerprint check. No test-layout registration.

## Docs and source-of-truth sync

Repository changes in this phase: the highlights file and the changelog-script change of step 0 (Revision 4), and the
unit record (step 10); step 8a verifies the published release text (audit M11). The rest of the release notes are generated by
`scripts/build-release-changelog.ts` from the commit range and PR labels (:1-11, :130-134); each wp
PR must carry its label (`enhancement` for wp2–wp8, `documentation` for docs-only follow-ups) and
none may carry `skip-changelog`.

## Enforcement bypass record

This phase adds no guard. The existing guards it relies on, for the record:

| Guard | Tier | Executing surface | Known bypass | Residual risk |
| --- | --- | --- | --- | --- |
| `lane=all` evidence | CI-enforced | `release-evidence.cjs` in `validate-dispatch`, `verify-npm`, `publish` | Repository admin edits the workflow or helper (policy fingerprints, :97-114, make that visible) | Low |
| Service-lifecycle evidence | CI-enforced | same | Same | Low |
| Publication hold | CI-enforced via repo variable | `release.yml:1602-1610` | Anyone who can set repository variables | Intended: it is an owner switch, not a security boundary |

## Verifiers

| Command | Run now? | Result (2026-11-11, base 00680193cb) | Reads this phase's target |
| --- | --- | --- | --- |
| `node .github/scripts/release-evidence.cjs policy-check` | yes | exit 0, "Evidence policy fingerprints match the working tree." | yes: the helper policy files the release trusts |
| `GH_TOKEN=… GITHUB_REPOSITORY=lidge-jun/opencodex node .github/scripts/release-evidence.cjs resolve` | yes | exit 0, `{"sourceSha":"00c02163e4…","ciRunId":42799528713}` (the newest qualifying source today; step 4 passes `R`) | yes: the evidence the dispatch will resolve |
| `gh variable get OCX_DEV_RELEASE_PUBLISH_ENABLED -R lidge-jun/opencodex` | yes | `true` | yes: the publication hold |
| `gh release view v2.100.1 … --json assets` | yes | 25 assets, `isDraft:false`, `isPrerelease:false` | yes: baseline for step 8's asset count |
| steps 2–9 | no | NOT RUN: they dispatch hosted workflows and publish; they run only after wp1–wp8 merge | — |

## Acceptance criteria

1. A `ci.yml` run titled `ocx-ci-v1 lane=all sha=R` completed with `success` on every `CI_JOBS` job
   (activation: step 2 dispatch; observed with `gh run view <id> --json jobs`).
2. A `service-lifecycle.yml` dispatch for `R` succeeded, and `release-evidence.cjs service R` exits 0
   (activation: step 2; required because `desktop/**` changed since `v2.100.1`).
3. The Release run for `tag=latest`, `dry-run=false`, `expected-sha=R` concluded `success` and its
   outcome summary shows three confirmed rows (activation: step 6).
4. `npm view @bitkyc08/opencodex@V gitHead` equals `R` and `dist-tags.latest` equals `V` (step 8).
5. `gh release view vV` is public, not a prerelease, with the 25 expected assets, and the
   `latest/download/latest.json` manifest reports `V` (step 8).
6. The packed `V` tarball contains `link.child-ops/1`, `link-child-codex-state/1` and
   `desktop-update-request/1` (step 8).
7. The docs site deploy for `vV` succeeded (step 9).
8. The published release body for `vV` starts with "## Remote Link changes", states A1 with its `--updates notify|off`
   opt-out, the default-on catalog fan-out with `--catalog-fanout manual`, and A5, and still contains the generated
   changelog (step 8a).

## Outcomes that need a person (NEEDS_HUMAN) or stop the loop

- **NEEDS_HUMAN:** `OCX_DEV_RELEASE_PUBLISH_ENABLED` is not `true` at step 4 (owner switch); a
  repository secret is missing or expired (`TAURI_SIGNING_PRIVATE_KEY*`, `APPLE_*` for notarization,
  npm trusted publishing) so packaging or `publish` fails; `release-history.cjs` refuses to
  reconcile npm, tags and releases (`structure/ops/docs-and-release.md`, "History reconciliation");
  npm published but `attach-release` failed, which needs a maintainer-attested
  `resume-after-npm-publish=true` dispatch with the original `version` and `expected-sha`
  (`release.yml:77-80`; `scripts/release.ts` cannot dispatch a resume); a SignPath request waits for
  manual approval (release-signing waits up to an hour, `release.yml:353-358`; an unapproved request
  ships an unsigned `ocx.exe` with a warning, which the owner should know before announcing).
- **BLOCKED:** the same CI or infrastructure failure in three consecutive cycles.
- **UNSAFE:** any step that would install or update a real Home, Child or this machine.
- Never republish a version, never delete a tag or release, never edit workflow files in this phase.

## Security review notes and risks

- The release itself is security-relevant (`MAINTAINERS.md:83-95`): it ships two new mutating
  surfaces (wp3 routes, wp8 link-listener write and Desktop request file). The release dispatch
  must cite the merged security reviews of wp3 and wp8; without them the release does not start.
- Tokens: `GH_TOKEN="$(gh auth token)"` is passed through the environment and never printed;
  `scripts/release.ts:27-29` keeps child stderr unprinted for the same reason.
- Version skew in the fleet after release: Homes on `V` target Children to `V` only when they run
  `auto-when-idle` on a stable Home (A1). Only the release tag moves Children; this phase moves none.

## Windows behaviour

The release is produced on hosted Windows runners (standalone `ocx.exe`, `.msi`, `keyring windows`,
`windows 1/11..11/11` in `CI_JOBS`). No Windows-specific step is added; Windows orchestrated update
and restart stay refused at runtime (`unsupported:windows-apply`, `unsupported:windows-restart`, 004 D20).

## Deviations from 004 and 000

- **First supporting version.** 004 D9 says "first release that contains both halves (>= 2.101.0 at
  this base)". `devReleaseVersion` derives `2.100.2` at this base (`package.json` 2.100.0, newest
  stable 2.100.1). Phases must gate on peer feature presence (`desktop-update-request/1`,
  `link-child-codex-state/1`), never on a hard-coded version number, and user-facing text names
  "the first release with Desktop update requests" until `V` is known.
- **Service-lifecycle evidence** is not mentioned in 000 or 004; it is a hard precondition here
  because wp8 touches `desktop/**` (`release-evidence.cjs:116`).


## Release notes requirement (A1)

The release notes must state, in their first lines about Remote Link, that an upgraded Home now updates idle
eligible Children to its own version automatically (`updates: auto-when-idle`, 070), that Desktop Children join
once both sides run this release (A5), and how to opt out: `ocx link policy --updates notify` or `off`, or the
Remote Link policy panel. A release whose notes omit this is not ready. Steps 0, 5a and 8a are the executable form of
this requirement (Revision 4: the text is in the notes the draft is created with, so it is public from the first
minute); it also discloses the default-on catalog fan-out (050).
