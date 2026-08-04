# 010 — Phase 1 (wp10-desktop3p-path-windows-ci)

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## MODIFY / NEW / DELETE map

MODIFY `src/claude/desktop-3p-paths.ts`

- Replace host-OS `join` import:
  - before: `import { join } from "node:path";`
  - after: `import { posix, win32 } from "node:path";`
- Add one local helper, next to the existing platform helper:
  - `joinForPlatform(platform, ...parts)` returns `win32.join(...)` when
    `platform === "win32"`, otherwise `posix.join(...)`.
- Change `resolveElectronUserData(inputs)`:
  - darwin branch keeps `/Users/test/Library/Application Support/...` semantics
    with `posix.join`.
  - win32 branch keeps `C:\...\AppData\Local\...` semantics with `win32.join`.
  - linux branch keeps `/home/test/.config/...` semantics with `posix.join`.
- Change `resolveConfigLibraryDir(inputs)`:
- keep `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` semantics unchanged: trim
  surrounding whitespace, then return the override without joining or
  target-platform normalization.
  - append `configLibrary` with `joinForPlatform(inputs.platform, userDataDir,
    "configLibrary")` so the separator follows the target platform, not the
    CI host.

MODIFY `tests/desktop-3p.test.ts`

- Import `{ posix, win32 }` from `node:path`.
- Replace host `join(...)` assertions with target-platform assertions:
  - POSIX expected paths use `posix.join(...)` or exact POSIX strings.
  - Windows expected paths use `win32.join(...)`.
- Keep the failing CI scenario covered:
  `platform: "darwin"` + `CLAUDE_USER_DATA_DIR: "/profiles/claude"` must return
  `/profiles/claude/configLibrary`.

MODIFY `tests/claude-desktop-config-path.test.ts`

- Import `{ posix, win32 }` from `node:path`.
- Replace host `join(...)` expectations with target-platform expectations for
  generated profile roots.
- Preserve tests that explicit overrides are returned verbatim.

## TESTS

- `tests/desktop-3p.test.ts`
  - existing Desktop 3P resolver table continues to cover override, Darwin,
    Windows, Linux XDG, and Linux HOME branches.
  - Windows-host regression is protected by asserting POSIX separator for
    non-Windows target platforms.
- `tests/claude-desktop-config-path.test.ts`
  - existing runtime wrapper tests continue to verify each platform's default
    root shape with deterministic environment/home inputs.

## Verification (C)

- `bun test tests/desktop-3p.test.ts tests/claude-desktop-config-path.test.ts`
  exits 0.
- `bun x tsc --noEmit` exits 0.
- `git diff --check origin/dev` exits 0.
- Hosted GitHub checks on the WP10 PR latest head are green before squash merge.
