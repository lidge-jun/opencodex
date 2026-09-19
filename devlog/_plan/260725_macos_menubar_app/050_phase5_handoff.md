# 050 — Phase 5: docs, PR consolidation, push

**Depends on:** `040` (nothing is documented or announced until it builds and packages).
**Independently verifiable by:** `gh pr view 387/421` showing `CLOSED` with the posted
comments, and `git ls-remote --heads origin feat/macos-app` matching local `HEAD`.

## File change map

| Path | Action |
| --- | --- |
| `docs-site/src/content/docs/guides/macos-menu-bar.md` | NEW (English source) |
| `docs-site/src/content/docs/ko/guides/macos-menu-bar.md` | NEW |
| `docs-site/src/content/docs/ja/guides/macos-menu-bar.md` | NEW |
| `docs-site/src/content/docs/zh-cn/guides/macos-menu-bar.md` | NEW |
| `docs-site/src/content/docs/ru/guides/macos-menu-bar.md` | NEW |
| `docs-site/astro.config.mjs` | MODIFY — sidebar entry |
| `README.md` | MODIFY — one line under features |
| `structure/00_overview.md` | MODIFY — `app/` in the layout map (SOT-SYNC-01) |
| `AGENTS.md` | MODIFY — one line in "Repository layout" |

`AGENTS.md` describes `src/`, `gui/`, `docs-site/`, `structure/`, `scripts/`, `devlog/`.
A new top-level `app/` that is not listed there would be invisible to the next agent.

## Documentation content

The guide answers, in order: what it is, how to get it, the Gatekeeper first launch,
what each part of the popover means, and how to build from source.

**Gatekeeper section is mandatory.** The release zip is ad-hoc signed, not notarized, so
the first launch shows *"OpenCodex.app cannot be opened because the developer cannot be
verified."* Without documentation this reads as a broken download. The guide gives the
right-click → Open path and the `xattr -d com.apple.quarantine` alternative, and states
plainly that notarization requires a paid Apple Developer identity the project does not
currently hold. PR #387 documented this across five locales and that instinct is correct.

Translated locales must not contradict the English source (`AGENTS.md` docs-sync rule).

## PR closure

Both PRs are closed with an English maintainer comment (`AGENTS.md`: always review in
English), naming what was taken from each. Credit is specific, not ceremonial — both
authors shipped work that materially shaped this implementation.

### To #387 (jaycho46)

Names what was adopted: the Swift/SwiftPM runtime choice, the two-target core/app split,
manual bundle assembly with the unexpected-path refusal guard, `codesign --verify --deep
--strict`, the `lipo` universal assertion, `ditto` archiving with archive-content
verification, the SHA-256 sidecar, the `package-macos` release job shape, the
Command-Line-Tools universal guard, and the Gatekeeper documentation.

States plainly what changed and why: the transport moved from `ocx status --json`
subprocess calls to the HTTP management API, because the CLI path required extending
`src/cli/status.ts` and the maintainer scope for this work excluded proxy runtime
changes — and because `/api/usage` and `/api/provider-quotas` already return richer data
with no proxy change at all.

Also states the cost of that choice honestly (`001` §4.2): the CLI transport could run
`ocx start`, and HTTP cannot. The maintainer app ships **Stop proxy** rather than pretend
to restart.

### To #421 (genglintong)

Names what was adopted: HTTP management-API transport, `runtime-port.json` discovery with
the 10100 fallback, Keychain-backed key storage, skipping auth when the proxy has no
`apiKeys` configured, the usage/health/status information set, and tabular-numeral stat
treatment.

**Do not credit renderer-side token isolation.** `001` §2 shows `menubar/src/api.ts:12-13`
returning the token into renderer memory at head `049ef2ac`, so the PR body's claim does
not hold and repeating it would put a false statement in the record.

**Must be written against head `049ef2ac`.** CodeRabbit's review is anchored to that same
head, so this is not a "bots reviewed an older tree" situation — the tree simply changed
after the Codex reviewer's P1. The contributor's commit titled "address all Codex review
findings (5 P1 + 14 P2)" removed the
committed `src-tauri/target/**` tree; `001` §2.1 verifies zero matching paths remain. The
comment explicitly acknowledges that fix. Repeating the stale defect would be factually
wrong and would misrepresent a contributor who responded to review properly.

The three remaining reasons Tauri was not adopted, and nothing else: no repository CI or
release attachment (`.github/` untouched, so no user can download a build), a materially
heavier build stack for a project whose premise is a single Bun process, and
`macOSPrivateApi: true` — a notarization and App-Store-rejection risk that `NSPopover`
avoids through public API.

The four-tab layout became a single column with a bounded scrolling middle so the primary question — "is it
running?" — is answered without a click.

Both comments state that the work is not discarded, point at this devlog unit, and invite
review of the maintainer branch.

**Pre-send check:** re-read both PR heads immediately before posting. A closing comment
that describes a stale head is the one failure mode that cannot be corrected after the
fact, because the PR is closed by the same action.

## Push

```bash
git push -u origin feat/macos-app
```

Push is pre-approved by the user for this branch only (`cxc-loop` LOOP-GIT-01: push is
ESCALATE by default; the user's instruction "커밋쌓고 두개 클로즈 하고 푸시" is the
approval, scoped to `feat/macos-app`).

**No PR is opened.** `.github/workflows/enforce-pr-target.yml` rewrites any PR not
targeting `dev` to `[WRONG BRANCH]` draft status. Opening one against `dev` is the
maintainer's call after reviewing the branch, and the user asked for a branch, not a PR.

## Commit sequence

One commit per phase, so `git log` reads as the build order:

```text
docs(devlog): plan macOS menu bar companion (Phase 0 roadmap)
feat(app): add macOS menu bar core — discovery, client, formatting
feat(app): add menu bar status item and popover UI
feat(app): wire proxy control and provider toggles
feat(release): build and package the macOS companion
docs(macos): document the companion and Gatekeeper first launch
```

## Devlog path hygiene

`scripts/privacy-scan.ts` excludes `devlog/`, so these documents are **not** covered by
the credential scan. That is a reason for more care, not less: absolute developer paths
(`/Users/<name>/...`) must not appear in tracked docs. Use repo-relative paths, or
`<worktree>` as a placeholder, and redact home directories when quoting evidence from
another contributor's machine.

## Accept criteria

1. Guide source added in five locales, linked from the sidebar, no locale contradictions,
   and `docs-site` builds with all five pages present. Public publication follows merge
   and a Pages deployment; this phase delivers the branch, not the deploy.
2. `README.md`, `AGENTS.md`, `structure/00_overview.md` mention `app/`.
3. #387 and #421 `CLOSED` with the comments above, each verified against the PR's head
   commit at the moment of posting.
4. `feat/macos-app` pushed; remote SHA equals local `HEAD`.
5. `bun run typecheck`, `bun run test`, `bun run privacy:scan` green on the final tree.
6. No absolute developer home path in any file this unit adds or modifies, including its
   `devlog/` docs. Pre-existing paths in unrelated historical devlogs are out of scope.
