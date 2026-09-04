# 030 - wp3: layout design and migration tooling

## Class call

C3. New scripts under `scripts/test-layout/`, one new helper, one new
layout test, edits to `scripts/test.ts`, `scripts/ci/run-bun-test-batches.sh`,
`scripts/release.ts`, `.github/workflows/ci.yml` and the oracle tests that
pin them. **No test file moves in this wp.** The tooling ships first, on a
still-flat tree, so every hazard fix is reviewable on its own and the move
PRs in wp4 are mechanical.

## 1. Design decisions (from 001/002/003)

1. `tests/<domain>/` mirrors `src/` (Hermes layout, Codex CLI ownership). One
   Bun package, so no per-crate `tests/` split.
2. Two nesting levels maximum: `tests/providers/cursor/` is the deepest.
   Every relative import to helpers therefore has exactly two shapes,
   `../helpers/x` and `../../helpers/x`, which is what the rewriter emits.
3. Helpers and fixtures stay at `tests/helpers/` and `tests/fixtures/`.
   `remove-tree` has 405 importers; moving it would touch every test in
   every PR. It does not move.
4. Repo-root resolution moves out of `import.meta.dir + "/.."` into one helper,
   `tests/helpers/repo-root.ts`, that walks up to the directory containing
   `package.json` with `"name": "@bitkyc08/opencodex"`. Source-oracle tests
   import it. Cwd-relative `Bun.file("src/...")` is left alone; it is cwd-stable.
5. Child-process helpers are located through the same helper
   (`join(repoRoot(), "tests", "helpers", name)`), never through
   `import.meta.dir`.
6. File-level sharding stays (Bun `--shard` and the batch script's sorted
   round-robin). Directory sharding would let one fat domain (providers 201)
   dominate a shard.
7. Files that must stay at `tests/` root: `preload.ts` (bunfig),
   `tsconfig.doctor-service-memory-contract.json` (ci.yml gates),
   `test-layout.test.ts` (new, below). Everything else moves in wp4.

## 2. Taxonomy (25 domains, 1061 files, from 001 §2.B)

| dir | n | src areas |
|---|---:|---|
| `tests/providers/` (+ `cursor/ kiro/ xai/ ollama/ github-copilot/`) | 201 | src/providers, src/adapters/cursor, src/oauth/cursor |
| `tests/codex-integration/` | 175 | src/codex |
| `tests/server/` | 95 | src/server (management, auth, listener) |
| `tests/adapters/` (+ `google/ anthropic/ openai/`) | 86 | src/adapters |
| `tests/responses/` | 63 | src/server/responses |
| `tests/lab/` | 53 | src/lab |
| `tests/cli/` | 45 | src/cli |
| `tests/routing/` | 34 | src/router, src/routing |
| `tests/gui/` | 31 | gui/src (source-oracle) |
| `tests/oauth/` | 31 | src/oauth |
| `tests/claude-integration/` | 28 | src/clients/claude* |
| `tests/ci-workflows/` | 27 | .github, scripts/release* |
| `tests/usage/` | 25 | src/usage, quota |
| `tests/lib/` | 21 | src/lib |
| `tests/clients/` | 20 | src/clients, integrations |
| `tests/service/` | 20 | src/service*, doctor |
| `tests/windows/` | 20 | src/windows*, winsw, tray |
| `tests/storage/` | 18 | storage policy, api-storage |
| `tests/vision/` | 17 | vision, sidecar |
| `tests/config/` | 16 | src/config |
| `tests/images/` | 12 | (exists) |
| `tests/web-search/` | 10 | src/adapters/*web-search |
| `tests/update/` | 9 | src/update |
| `tests/videos/` | 3 | (exists) |
| `tests/e2e-style/` | 1 | (exists) |

The authoritative file-to-directory map is `scripts/test-layout/layout.json`,
generated once from 001 §2.D and then hand-corrected; the mover reads it, the
layout test asserts it.

## 3. Files (NEW / MODIFY)

### NEW `tests/helpers/repo-root.ts`

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@bitkyc08/opencodex";
let cached: string | null = null;

/** Repository root, found by walking up from this helper to the package.json that names opencodex. */
export function repoRoot(): string {
  if (cached) return cached;
  let dir = import.meta.dir;
  for (let hops = 0; hops < 8; hops += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (parsed.name === PACKAGE_NAME) {
        cached = dir;
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("tests/helpers/repo-root: package.json for " + PACKAGE_NAME + " not found above " + import.meta.dir);
}

/** Absolute path of a file under tests/helpers, for child-process spawns. */
export function helperPath(name: string): string {
  return join(repoRoot(), "tests", "helpers", name);
}

/** Absolute path under the repository (for source-oracle reads). */
export function repoPath(...segments: string[]): string {
  return join(repoRoot(), ...segments);
}
```

Test: `tests/helpers/repo-root.test.ts` is not created (helpers are not tests);
the layout test below exercises it.

### NEW `scripts/test-layout/layout.json`

```json
{
  "version": 1,
  "root": "tests",
  "keepAtRoot": ["preload.ts", "tsconfig.doctor-service-memory-contract.json", "test-layout.test.ts"],
  "domains": {
    "providers": { "match": ["^(provider|providers|registry|mimo|baseten|chutes|deepinfra|nous|opencode|zai|moonshot|minimax|qwen|glm|groq|together|fireworks|openrouter|deepseek)-"], "children": {
      "cursor": ["^cursor-"], "kiro": ["^kiro-"], "xai": ["^(xai|grok)-"], "ollama": ["^ollama-"], "github-copilot": ["^github-copilot-"] } },
    "codex-integration": { "match": ["^(codex|native|catalog)-"] },
    "server": { "match": ["^(server|api|management|loopback|listener|bounded-body|cancel-body|ws-endpoint)-"] },
    "adapters": { "match": ["^adapter"], "children": { "google": ["^(google|gemini|antigravity)-"], "anthropic": ["^(anthropic|claude-messages)"], "openai": ["^(openai-chat|openai-responses|openai-provider-option)"] } },
    "responses": { "match": ["^(responses|sse|chat-completions|relay|passthrough|reasoning-replay|transient-budget)"] },
    "lab": { "match": ["^lab-"] },
    "cli": { "match": ["^(cli|ocx|star)-"] },
    "routing": { "match": ["^(router|routing|combo|subagent)-"] },
    "gui": { "match": [], "explicit": [] },
    "oauth": { "match": ["^(oauth|chatgpt-oauth|chatgpt-device)"] },
    "claude-integration": { "match": ["^(claude|desktop-3p)"] },
    "ci-workflows": { "match": ["^(ci-|zz-ci-|release-|bump-dev|repo-hygiene|closed-pr|cleanup-orphaned|install-scripts|privacy-scan|keyring-smoke|dsh-rc6|build-release|compatibility-version|skill-ocx|test-runner|bun-runtime|fixture-dir)"] },
    "usage": { "match": ["^(usage|request|quota|rate-limit)"] },
    "lib": { "match": ["^(strict-semver|remove-tree|lib-)"] },
    "clients": { "match": ["^(clients|integrations|sync-client|aside-client)"] },
    "service": { "match": ["^(service|doctor|systemd|launchd)"] },
    "windows": { "match": ["^(windows|win-|winsw|tray)"] },
    "storage": { "match": ["^(api-storage|storage|stale-state)"] },
    "vision": { "match": ["^(vision|sidecar)"] },
    "config": { "match": ["^config"] },
    "web-search": { "match": ["^web-search"] },
    "update": { "match": ["^update"] },
    "images": { "existing": true }, "videos": { "existing": true }, "e2e-style": { "existing": true }
  },
  "explicit": {}
}
```

The `match` regexes are the seed. `explicit` is a filename -> dir map that wins
over regexes and is where the 9 disagreeing files from 001 §2 (GUI oracles named
`claude-*`, `codex-*`, ..., and `openai-responses-passthrough.test.ts`) and every
file the regexes miss are pinned. `bun scripts/test-layout/plan.ts` prints the
unresolved list until it is empty; the committed `layout.json` resolves all 1061.

### NEW `scripts/test-layout/plan.ts`

Reads `layout.json`, lists `tests/**/*.test.ts`, prints
`<current> -> <target>` for every file not already at its target, plus
`UNRESOLVED <file>` lines. Exit 1 if any unresolved. Flags: `--domain <name>`
restricts output to one domain (the per-PR slice in wp4), `--json`.

### NEW `scripts/test-layout/move.ts`

`bun scripts/test-layout/move.ts --domain <name> [--dry-run]`:

1. `plan()` for the domain.
2. For each pair: `git mv <from> <to>` (fails if the file is dirty).
3. Rewrite in the moved file:
   - `from "../helpers/` -> `from "<up>/helpers/` where `<up>` is `..` or `../..` by depth
   - same for `../fixtures/`, `../preload`, `./helpers/`, `./fixtures/`
   - `from "../src/` -> `from "<up>/src/`; same for `../gui/`, `../scripts/`, `../bin/`
   - `new URL("../src/` / `new URL("./helpers/` / `new URL("../scripts/` / `new URL("../package.json"` -> depth-adjusted
   - `join(import.meta.dir, "..", ...)` and `join(import.meta.dir, "../src"` -> `repoPath(...)` with an added import of `repo-root`
   - `join(import.meta.dir, "helpers", X)` -> `helperPath(X)`
   - `join(repoRoot, "tests", "helpers", X)` / `resolve(repoRoot, "tests/helpers/X")` -> `helperPath(X)` when a local `repoRoot` was `import.meta`-derived
   - `join(process.cwd(), "tests", "helpers", X)` -> `helperPath(X)`
4. Rewrite every other file that names the moved path as a literal
   (`rg -l --fixed-strings "tests/<basename>"` over `tests scripts .github AGENTS.md src docs-site structure`),
   replacing `tests/<basename>` with `tests/<domain>/<basename>`. Prints each edit.
5. Runs `bun scripts/test-layout/verify.ts --domain <name>`.

The rewriter is regex-based and conservative: any `import.meta.dir` use it cannot
classify is printed as `MANUAL <file>:<line>` and the run exits 2 so the operator
edits it by hand before committing.

### NEW `scripts/test-layout/verify.ts`

For a domain (or all):
- every file in the domain resolves its imports: `bun build --no-bundle` is not
  usable for TS-only; instead `bun x tsc --noEmit -p scripts/test-layout/tsconfig.verify.json`
  with `include: ["tests/<domain>/**/*.ts", "tests/helpers/**/*.ts"]`,
  `noEmit`, `skipLibCheck`, `types: ["bun-types"]`. Tests are not typechecked by
  the root tsconfig today (001 §4.A), so this catches only unresolved
  modules and gross breakage, which is exactly what a move can cause.
- no remaining `import.meta.dir` + `".."` pattern in the domain (rg).
- `rg --fixed-strings "tests/<basename>"` finds no stale literal for any moved file.
- runs `bun test --isolate tests/<domain>` (focused, permitted).

### NEW `tests/test-layout.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { helperPath, repoPath, repoRoot } from "./helpers/repo-root";
import layout from "../scripts/test-layout/layout.json";

// Every *.test.ts under tests/ must sit in a directory layout.json knows about, and every
// root-level test file must be on the keepAtRoot list. Migrated domains are listed in
// layout.migrated; a file in a migrated domain that is still at root fails here.
describe("tests/ layout", () => {
  test("repo-root helper resolves the package", () => {
    expect(repoRoot()).toBe(repoPath());
    expect(helperPath("remove-tree.ts")).toBe(join(repoRoot(), "tests", "helpers", "remove-tree.ts"));
  });

  test("no test file outside a known domain once its domain is migrated", () => {
    const root = join(repoRoot(), "tests");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { if (!["helpers", "fixtures"].includes(entry)) walk(full); continue; }
        if (!entry.endsWith(".test.ts")) continue;
        const rel = relative(root, full);
        const dirName = rel.includes("/") ? rel.split("/")[0] : "";
        if (dirName === "") {
          if (!(layout.keepAtRoot as string[]).includes(entry) && (layout.migrated as string[]).some(d => layout.explicit[entry] === d)) offenders.push(rel);
        } else if (!(dirName in layout.domains)) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
```

`layout.migrated` starts as `[]`; each wp4 PR appends its domain, so the test
tightens one slice at a time and never fails on a not-yet-moved domain.

### MODIFY `scripts/test.ts` (serial lanes)

```diff
-export const SERIAL_FULL_SUITE_FILES = [
-  "codex-shim.test.ts",
-  "cursor-native-exec-shell.test.ts",
-  "issue-452-empty-503.test.ts",
-  "openai-provider-option-e2e.test.ts",
-  "release-helper.test.ts",
-  "update-stop-first.test.ts",
-] as const;
+// Paths relative to tests/. They move with the file in the same PR (tests/test-layout.test.ts
+// and tests/test-runner.test.ts both pin them).
+export const SERIAL_FULL_SUITE_FILES = [
+  "codex-shim.test.ts",
+  "cursor-native-exec-shell.test.ts",
+  "issue-452-empty-503.test.ts",
+  "openai-provider-option-e2e.test.ts",
+  "release-helper.test.ts",
+  "update-stop-first.test.ts",
+] as const;
```

The array stays the same in wp3 (nothing has moved). What changes in wp3 is
the interpolation and the ignore pattern so a later relative path works:

```diff
-  const ignores = SERIAL_FULL_SUITE_FILES.flatMap(file => ["--path-ignore-patterns", `**/${file}`]);
+  const ignores = SERIAL_FULL_SUITE_FILES.flatMap(file => ["--path-ignore-patterns", `**/${basename(file)}`]);
...
-      args: resolveBunTestArgs(["--parallel=1", ...serialRequested, `./tests/${file}`]),
+      args: resolveBunTestArgs(["--parallel=1", ...serialRequested, `./tests/${file}`]),
```

and `SERIAL_LANE_TIMEOUT_MS` keys plus lane `label` use `basename(file)`. In wp4
the entries become `"codex-integration/codex-shim.test.ts"` etc. and
`tests/test-runner.test.ts:167-246` expectations update to the same strings.
`import { basename } from "node:path"` is added.

### MODIFY `scripts/ci/run-bun-test-batches.sh`

```diff
 is_general_test_file() {
   local path="$1"

   case "$path" in
-    tests/api-storage-policy*.test.ts|tests/api-storage.test.ts|tests/api-usage.test.ts)
+    # Dedicated CI jobs run these in their own Bun process (ci.yml storage-policy / api-usage).
+    # Match by basename at any depth so the exclusion survives the tests/ domain layout.
+    */api-storage-policy*.test.ts|*/api-storage.test.ts|*/api-usage.test.ts)
       return 1
       ;;
   esac
```

### MODIFY `tests/zz-ci-storage-policy-isolation.test.ts` and `tests/zz-ci-api-usage-isolation.test.ts`

```diff
-  expect(batchHelper).toContain("tests/api-storage-policy*.test.ts");
-  expect(batchHelper).toContain("tests/api-storage.test.ts");
+  expect(batchHelper).toContain("*/api-storage-policy*.test.ts");
+  expect(batchHelper).toContain("*/api-storage.test.ts");
```
```diff
-  expect(batchHelper).toContain("tests/api-usage.test.ts)");
+  expect(batchHelper).toContain("*/api-usage.test.ts)");
```

The `testPathPattern` regex in the storage oracle becomes
`/\.\/tests\/[a-z0-9\-\/]+\.test\.ts/g` so a `./tests/storage/...` path matches
in wp4; `dedicatedFiles` stays flat until the storage slice moves.

### MODIFY `scripts/release.ts:539-545`

No change in wp3 (paths still valid). Listed here because wp4's storage slice
must edit it together with `ci.yml:344-349,381` and the two oracles.

### MODIFY `tests/repo-hygiene.test.ts:5`, `tests/skill-ocx.test.ts:18`, `tests/bun-runtime.test.ts:245`, `tests/release-version-line.test.ts:55`

```diff
-const repoRoot = fileURLToPath(new URL("../", import.meta.url));
+import { repoRoot as resolveRepoRoot } from "./helpers/repo-root";
+const repoRoot = resolveRepoRoot();
```
```diff
-const SKILL_DIR = join(import.meta.dir, "..", "skills", "ocx");
+const SKILL_DIR = repoPath("skills", "ocx");
```

Same shape for the `../package.json` and `join(import.meta.dir, "..", relative)` reads.
Doing these four in wp3 proves the helper on real oracles before the mover
relies on it.

### MODIFY `AGENTS.md` (repository layout paragraph)

```diff
-- `tests/` — flat Bun tests (`tests/*.test.ts`); shared fixtures in
-  `tests/helpers/`, broader scenarios in `tests/e2e-style/`.
+- `tests/` — Bun tests in domain directories mirroring `src/`
+  (`tests/<domain>/*.test.ts`; map in `scripts/test-layout/layout.json`); shared
+  helpers in `tests/helpers/`, fixtures in `tests/fixtures/`, broader scenarios in
+  `tests/e2e-style/`. Source-oracle tests resolve the repository through
+  `tests/helpers/repo-root.ts`, never `import.meta.dir + "/.."`.
```

Plus the `bun test tests/<name>.test.ts` example becomes `bun test tests/<domain>/<name>.test.ts`.

## 4. Verification for wp3

- `bun x tsc --noEmit` (root; scripts/ are outside include, so also
  `bun x tsc --noEmit -p scripts/test-layout/tsconfig.verify.json`).
- `bun test tests/test-layout.test.ts tests/test-runner.test.ts tests/zz-ci-storage-policy-isolation.test.ts tests/zz-ci-api-usage-isolation.test.ts tests/repo-hygiene.test.ts tests/skill-ocx.test.ts tests/bun-runtime.test.ts tests/release-version-line.test.ts tests/ci-workflows.test.ts`
- `bun scripts/test-layout/plan.ts` exits 0 with zero UNRESOLVED (proves the map covers 1061).
- `bun scripts/test-layout/move.ts --domain windows --dry-run` prints the 20 moves and the rewrites without touching the tree.
- `bun run test:changed`, `bun run privacy:scan`.
- PR to `dev`, exact-head `ci` success, admin merge, ancestry proof.

