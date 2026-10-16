# 020 — #6973 Codex app bundled CLI as a macOS runtime candidate

## Live layout (measured 2026-10-13, ChatGPT.app 26.1007.21159, this host)

- `/Applications/ChatGPT.app/Contents/Info.plist` is an XML plist (20,800 bytes), `CFBundleIdentifier = com.openai.codex`.
- `Contents/Resources/codex-cli/codex-package.json`: `{"layoutVersion":1,"version":"0.162.0-alpha.17.2","entrypoint":"bin/codex",...}`.
- `Contents/Resources/codex-cli/bin/codex` is a 328-byte POSIX shell wrapper that execs
  `../CodexCLI.app/Contents/MacOS/codex`; `--version` prints `codex-cli 0.162.0-alpha.17.2` and
  `debug models --bundled` returns a models catalog (exit 0).
- The running app-server is `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
- The older layout `Contents/Resources/codex` (measured 2026-09-13,
  `devlog/_fin/260913_cross_platform_desktop_app_restart/001_platform_topology.md` §1.1) is absent in this release.

Candidates per bundle, in order: `Contents/Resources/codex-cli/bin/codex` (current entrypoint), then
`Contents/Resources/codex` (older layout). Bundles: `/Applications/ChatGPT.app`, then `$HOME/Applications/ChatGPT.app`.

## Contract

1. macOS only. Precedence: env override → persisted selection → shim → PATH → established installed
   locations → bare `codex` fallback → app candidates (system before user, current layout before older).
2. A candidate counts only if it exists and the bundle's top-level `Contents/Info.plist` reports
   `CFBundleIdentifier = com.openai.codex`, read in-process: regular file, ≤ 64 KiB, XML plist only
   (binary/other formats → no identity), exactly one top-level `CFBundleIdentifier` key. No subprocess.
3. Identity is re-checked in `versionProbePrecheck`, so a persisted app path is revalidated after the app is
   replaced, and an explicit override pointing into an app bundle must also pass.
4. App candidates never take over a runnable automatically persisted (unpinned) selection: excluded from the
   fast-path handover exception (`src/codex/runtime.ts:1054`) and from `supersededDiscovered` selection
   (`src/codex/runtime.ts:1110-1112`). They may still appear in `newerAvailable`. Invalid-runtime recovery keeps
   `replacedConfigured` (`src/codex/runtime.ts:1083-1088`).
5. With `probeVersion:false` the bare fallback is skipped as a selectable candidate so deferred discovery can
   reach the app (`src/codex/runtime.ts:428,1026`); the no-candidate return still yields the fallback sentinel.
6. Consumers: catalog (`debug models --bundled`) and prompt (`debug prompt-input`) already map unsupported
   command and spawn failures to unavailable (`src/codex/catalog/bundled.ts:349,405`,
   `src/codex/prompt-text-probe.ts:481,555,627`). Structurally malformed JSON currently throws
   (`src/codex/catalog/parsing.ts:340` on `{"models":[null]}`; `src/codex/prompt-text-probe.ts:779-781` on
   `[null]` / `[{"content":[null]}]`) and is guarded to unavailable / `output-invalid`.

## Diff

### MODIFY `src/codex/runtime.ts`

- `ResolveCodexRuntimeDeps`: add `readBundleIdentifier?: (infoPlistPath: string) => string | null`; include it in the
  memo-bypass list next to `readFileSync` (`:834`).
- NEW helpers before `installedCodexCandidates` (`:612`): `macCodexAppBundles(deps)`,
  `macCodexAppCommands(deps)` (bundle × [codex-cli/bin/codex, codex]), `macCodexAppBundleFor(command, deps)`,
  `macCodexAppIdentityMatches(command, deps)` (true for non-app commands), `readBoundedBundleIdentifier(path)`
  (fd-based, regular file, 64 KiB + 1 overflow byte, XML-only top-level dict parse).
- `installedCodexCandidates`: on darwin append existing app commands that pass identity.
- `versionProbePrecheck` (`:428`): identity check before the `probeVersion:false` return.
- Candidate assembly (`:1023`): non-app installed → bare fallback → app candidates.
- Candidate loop (`:1047`): skip `fallback` when `probeVersion === false`.
- Handover (`:1054`, `:1112`): exclude app commands.

### MODIFY `src/codex/catalog/bundled.ts` (`:315`)

Require every `catalog.models` row to be a non-array object before `findNativeTemplate`.

### MODIFY `src/codex/prompt-text-probe.ts` (`:779-781`)

Skip non-object items; take `text` only when it is a string.

### Docs

- `docs-site/src/content/docs/guides/codex-integration.md` (after `:395`) plus `ko`, `zh-cn`, `zh-tw` mirrors: one
  sentence describing the app candidate, its precedence, identity check and no automatic takeover.
- `structure/codex-home.md:43` discovery/handover prose; `structure/catalog.md:102` and
  `structure/codex-prompts.md:55` malformed-output behavior where they describe it.

## Tests

NEW `tests/codex-integration/codex-runtime-macos-desktop.test.ts` — appended on the existing
`"codex-runtime.test.ts": "codex-integration",` line of `scripts/test-layout/layout.json` (`:684`) and the matching
row of `tests/fixtures/test-layout-expected.json` (`:479`). Cases: current-layout and older-layout discovery,
system before user, explicit/established precede app, fallback precedes app during version discovery, deferred
discovery reaches the app, persisted discovered CLI never hands over to a newer app, full discovery reports it in
`newerAvailable`, pinned stays, missing/mismatched/binary/oversized/duplicate identity excludes, persisted app path
revalidated after replacement, missing app copy → `replacedConfigured`, non-macOS never reads plist, sync and
async agree, injected reader bypasses memo, bundled-models null rows → unavailable.

MODIFY `tests/codex-integration/codex-prompt-text-probe.test.ts`: `[null]` and `[{"content":[null]}]` → `output-invalid`.
`tests/codex-integration/codex-catalog.test.ts` is near its cap (7,974/7,985) and is not touched.

## Residuals

Identity is metadata, not code-signature attestation. Real-app qualification beyond this host's layout is not
possible from the lane; older and future layouts are covered by fixtures only.


## Amendments after architect reflection (Huygens, ALIGNED with gaps → folded)

- **Bundle membership.** `macCodexAppBundleFor(command)` classifies any absolute path whose `path.posix.normalize`d form
  starts with `<bundle>/` (segment boundary, so `ChatGPT.app-other` is excluded) for either conventional bundle. That
  classification drives the identity check in `versionProbePrecheck` and the handover exclusion, so the backing
  executable `codex-cli/CodexCLI.app/Contents/MacOS/codex` used as an explicit override is identity-checked too. Tests:
  backing-executable override with matching and mismatching identity; sibling prefix rejection.
- **Consumer matrix.** Catalog: valid output accepted, unsupported command and spawn failure unavailable, null rows
  unavailable — sync and async. Prompt: `[null]`, `[{"content":[null]}]` → `output-invalid`; spawn failure of a
  resolved installed runtime → `program-not-found`; existing unsupported/valid coverage cited
  (`tests/codex-integration/codex-prompt-text-probe.test.ts:699,747`).
- **Handover variants.** The persisted-selection case is parameterized over absent `origin` and `"discovered"`, and over
  full discovery and `discoverAlternatives:false`.
- **Prompt live compatibility** is measured on this host during implementation; if `debug prompt-input` is not
  supported by the app CLI, the existing unavailable path applies and the residual is recorded.
- Optional docs sentences in `guides/remote-hub.md` and `guides/codex-prompt.md` are skipped (not needed for the contract).


## Measurement during A (2026-10-13)

`CODEX_HOME=<isolated tmp> /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex debug prompt-input` → exit 0,
11,906 bytes of message JSON, empty stderr. Prompt compatibility for the current app release is established on this host.
Existing handover/runtime suites run alongside the new file: `tests/codex-integration/codex-runtime.test.ts`,
`codex-runtime-wsl-desktop.test.ts`, `codex-prompt-text-probe.test.ts`, and the catalog bundled tests that cover the
changed guard.


**Correction (audit round 2, P3):** the measurement proves command execution only. Consumer compatibility (recognized
prompt sections through `src/codex/prompt-text-probe.ts`) is checked during implementation by running the existing
parser against the app binary and recording bounded metadata (section count, no prompt text); until then it is pending.


## wp2 P revalidation (2026-10-13)

Lane head is `fc9d078201` (wp1, #6853). That commit touches none of wp2's source/test/doc targets or registration anchors
(`git -C /private/tmp/rt284-lanes/L4 diff --stat 3e58c2ce3e fc9d078201` lists only service/status/docs-desktop files),
so every anchor in this doc still refers to the base tree. Implementation proceeds on branch `codex/rt284-L4-6973`
(worktree `/private/tmp/rt284-lanes/L4-6973`) and is cherry-picked onto the lane branch; its `layout.json` and
`test-layout-expected.json` edits touch different lines from wp1's.

