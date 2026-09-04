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
7. Files that stay at `tests/` root: `preload.ts` (bunfig),
   `tsconfig.doctor-service-memory-contract.json` (ci.yml gates),
   `fake-codex-server.ts` (root support file with no current importer; kept in
   place and listed in `keepAtRoot` so the guard does not treat it as unresolved,
   deletion is a separate decision), and the two new guard tests `test-layout.test.ts` and `test-layout-tooling.test.ts`
   (below). All 1045 existing root `*.test.ts` files move in wp4; with the two
   new files the suite is 1063.
8. Depth-aware rewriting: a file at `tests/<domain>/` reaches `tests/helpers` with
   `../helpers` and the repo root with `../..`; a file at `tests/<domain>/<sub>/`
   uses `../../helpers` and `../../..`. The rewriter computes both offsets from the
   target path separately (`toHelpers` and `toRepo`), never one shared prefix.

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
  "keepAtRoot": ["preload.ts", "fake-codex-server.ts", "tsconfig.doctor-service-memory-contract.json", "test-layout.test.ts", "test-layout-tooling.test.ts"],
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
  "explicit": {},
  "migrated": []
}
```

`scripts/test-layout/schema.ts` exports `type Layout = { version: 1; root: "tests"; keepAtRoot: string[]; domains: Record<string, Domain>; explicit: Record<string, string>; migrated: string[] }` and `resolveTarget(layout, basename): string | null` (explicit first, then children regexes, then domain regexes, first match wins, `null` = unresolved). The mover, `plan.ts`, and the layout test all import this one resolver, so "where does file X belong" has exactly one answer.

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

`bun scripts/test-layout/move.ts --domain <a> [--domain <b> ...] [--dry-run]`:

A slice is one invocation with every domain of that PR, so the sequence is
preflight-all, move-all, rewrite-all, verify-all. The cleanliness gate (step 3)
runs once over the union of source files before the first `git mv`; rewrites
the mover itself makes in step 4 are therefore never mistaken for dirt.
`layout.migrated` is appended with every selected domain before step 5 runs, so
`currentPath` and the layout guard see the post-move state during verification.

1. `plan()` for every selected domain (union, deduplicated).
2. For each pair: `git mv <from> <to>` after the cleanliness check in step 3.
3. Rewrite in the moved file. Let `toHelpers` be `..` (depth 1) or `../..`
   (depth 2) and `toRepo` be `../..` or `../../..`:
   - static `import ... from "<spec>"`, dynamic `await import("<spec>")`,
     `require("<spec>")`, `import.meta.resolve("<spec>")`, and
     `new URL("<spec>", import.meta.url)` are all handled by one function
     `rewriteSpecifier(spec)`: `./helpers/` and `../helpers/` -> `${toHelpers}/helpers/`;
     same for `fixtures/`, `preload`, `fake-codex-server`; `../src/`, `../gui/`,
     `../scripts/`, `../bin/`, `../package.json`, `../.gitignore`, `../.github/`,
     `../skills/`, `../docs-site/`, `../structure/`, `../devlog/` and the bare
     `"../"` root URL -> `${toRepo}/...`. Specifiers that do not start with `./` or
     `../` are untouched.
   - `join(import.meta.dir, "..", ...)`, `join(import.meta.dir, "../src", ...)`,
     `resolve(import.meta.dir, "..")`, `fileURLToPath(new URL("../", import.meta.url))`,
     `new URL("../", import.meta.url)` -> `repoPath(...)` / `repoRoot()` with an
     added import of `repo-root`.
   - `join(import.meta.dir, "helpers", X)`, `join(repoRoot, "tests", "helpers", X)`,
     `resolve(repoRoot, "tests/helpers/X")`, `join(process.cwd(), "tests", "helpers", X)`
     -> `helperPath(X)`.
   - MANUAL scan, post-rewrite: a line containing `import.meta.dir` or
     `import.meta.url` is flagged only when it is an *escape* from the file's own
     directory: the same statement contains `".."` / `"../` / `"helpers/` /
     `"fixtures/` / `"src/` / `"gui/` / `"scripts/` / `"tests/` as a string literal,
     or a `new URL("../`. File-local uses (`join(import.meta.dir, ".tmp-x")`,
     `import.meta.path`, self-file reads such as `tests/service.test.ts:2388-2447`,
     `tests/doctor.test.ts:36`) are not escapes and pass. A line that is a
     legitimate escape the rewriter cannot express (`tests/windows-tray.test.ts:493`
     reads a source-oracle string) is accepted by a same-line trailing marker
     `// layout: local` that a human adds after reading it; the mover prints every
     marker it honoured so the reviewer sees them in the PR. Flagged lines print as
     `MANUAL <file>:<line>` and the run exits 2. Sites the rules above
     handle automatically (dynamic imports in `openai-provider-option-e2e.test.ts:258-272`,
     the root URL in `core-lab-boundary.test.ts:34`) are not MANUAL; the dry-run
     output on the flat tree is the authoritative list of what is.
   - Cleanliness: before any `git mv`, `git status --porcelain -- tests/<from>`
     must be empty (staged or unstaged); a dirty file aborts the whole domain
     with the list printed. `git mv` itself does not refuse a dirty tracked file,
     so this check is what prevents an unrelated edit from riding inside a rename.
4. Rewrite every other file that names the moved path as a literal
   (`rg -l --fixed-strings "tests/<basename>"` over `tests scripts .github AGENTS.md src docs-site structure`),
   replacing `tests/<basename>` with `tests/<domain>/<basename>`. Prints each edit.
5. Appends the selected domains to `layout.migrated`, then runs
   `bun scripts/test-layout/verify.ts --domain <each>`.

The rewriter is regex-based and conservative: any `import.meta.dir` use it cannot
classify is printed as `MANUAL <file>:<line>` and the run exits 2 so the operator
edits it by hand before committing.

### NEW `scripts/test-layout/verify.ts`

For a domain (or all):
- every file in the domain resolves its imports: `bun build --no-bundle` is not
  usable for TS-only; instead `bun x tsc --noEmit -p scripts/test-layout/tsconfig.verify.json`
  with the committed `include: ["../../scripts/test-layout/**/*.ts", "../../tests/test-layout.test.ts", "../../tests/test-layout-tooling.test.ts", "../../tests/helpers/**/*.ts"]` (relative to `scripts/test-layout/`); `verify.ts --domain X` writes a temp config under `.tmp/` that `extends` it and lists absolute paths (`join(repoRoot(), "scripts/test-layout/**/*.ts")`, ..., `join(repoRoot(), "tests", X, "**/*.ts")`) in its own `include` (`include` is replaced, not merged, through `extends`, and relative entries would resolve under `.tmp/`), runs tsc with `-p` on that file, then deletes it,
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
import { join, relative, sep } from "node:path";
import { helperPath, repoPath, repoRoot } from "./helpers/repo-root";
import { loadLayout, resolveTarget } from "../scripts/test-layout/schema";

// Every *.test.ts under tests/ must resolve to a domain, and once a domain is listed in
// layout.migrated no file that resolves to it may still sit at the root. Root support files
// are on keepAtRoot. Uses the same resolver as the mover, so the guard and the tool agree.
describe("tests/ layout", () => {
  const layout = loadLayout();
  const root = join(repoRoot(), "tests");

  test("repo-root helper resolves the package", () => {
    expect(repoRoot()).toBe(repoPath());
    expect(helperPath("remove-tree.ts")).toBe(join(root, "helpers", "remove-tree.ts"));
  });

  test("every test file resolves to a domain and migrated domains hold no stragglers", () => {
    const unresolved: string[] = [];
    const stragglers: string[] = [];
    const misplaced: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { if (entry !== "helpers" && entry !== "fixtures") walk(full); continue; }
        if (!entry.endsWith(".test.ts")) continue;
        const rel = relative(root, full).split(sep).join("/"); // posix form on every OS
        const target = resolveTarget(layout, entry);
        if (target === null) { if (!layout.keepAtRoot.includes(entry)) unresolved.push(rel); continue; }
        const dirName = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        if (dirName === "" && layout.migrated.includes(target.split("/")[0]!)) stragglers.push(rel);
        if (dirName !== "" && dirName !== target) misplaced.push(`${rel} -> ${target}`);
      }
    };
    walk(root);
    expect({ unresolved, stragglers, misplaced }).toEqual({ unresolved: [], stragglers: [], misplaced: [] });
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

### MODIFY `tests/fixture-dir-uniqueness.test.ts`

It scans `readdirSync(import.meta.dir)` non-recursively and opens two root basenames
directly (`:20,28-31,49-50,71-77`). After the move it would scan only `ci-workflows/`
and pass vacuously. In wp3, before anything moves:

```diff
-const TESTS_DIR = import.meta.dir;
+import { repoPath } from "./helpers/repo-root";
+const TESTS_DIR = repoPath("tests");
...
-function testFiles(): string[] {
-  return readdirSync(TESTS_DIR)
-    .filter(name => name.endsWith(".test.ts") && name !== SELF)
-    .sort();
-}
+function testFiles(): string[] {
+  const out: string[] = [];
+  const walk = (dir: string) => {
+    for (const entry of readdirSync(dir, { withFileTypes: true })) {
+      if (entry.isDirectory()) { if (entry.name !== "helpers" && entry.name !== "fixtures") walk(join(dir, entry.name)); continue; }
+      if (entry.name.endsWith(".test.ts") && entry.name !== SELF) out.push(relative(TESTS_DIR, join(dir, entry.name)));
+    }
+  };
+  walk(TESTS_DIR);
+  return out.sort();
+}
```

and the two direct basename reads at `:71-77` use `currentPath(layout, basename)`
from `schema.ts`: `resolveTarget` if that domain is in `layout.migrated`, otherwise
the root, so the reads follow each file across slices instead of pointing at a
directory that does not exist yet. This is the one test whose invariant spans the whole tree; it
is proven on the flat tree in wp3 (same pass/fail set) before any move.

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

### NEW `tests/test-layout-tooling.test.ts`

Table-driven, runs on the flat tree, no git side effects (operates on a
`mkdtempSync` copy with its own `git init`):

- `rewriteSpecifier`: the matrix is generated, not hand-listed: depths {1, 2} x
  syntax forms {static named import, side-effect `import "x"`, `export ... from`,
  `await import()`, `require()`, `import.meta.resolve()`, `new URL(..., import.meta.url)`}
  x every prefix the implementation declares (the test imports the same
  `REWRITE_PREFIXES` table from `schema.ts`, so a prefix added to the mover
  without a case fails here: `./helpers/`, `../helpers/`, `./fixtures/`, `../fixtures/`,
  `./preload`, `../preload`, `./fake-codex-server`, `../fake-codex-server`, `../src/`,
  `../gui/`, `../scripts/`, `../bin/`, `../package.json`, `../.gitignore`, `../.github/`,
  `../skills/`, `../docs-site/`, `../structure/`, `../devlog/`, `"../"`), each with the
  expected output string; plus negative cases
  (`bun:test`, `node:fs`, package names, `./sibling` at depth 0) unchanged.
- `import.meta` rewrites: each pattern in step 3 bullets 2-3 to `repoPath`/`repoRoot`/`helperPath`,
  and that the `repo-root` import is added once.
- MANUAL scan: a file-local `join(import.meta.dir, ".tmp-x")` passes; a
  `join(import.meta.dir, "..", "src")` that survived rewriting fails; a flagged
  line with `// layout: local` passes and is reported.
- Cleanliness: a dirty file in the selected domains aborts before any `git mv`
  (assert the tree is untouched); a dirty file outside the slice does not.
- `resolveTarget`: explicit beats child regex beats domain regex; unknown -> `null`.
- `currentPath`: root before `migrated`, target after.
- Independent mapping oracle: `tests/fixtures/test-layout-expected.json` is the
  full basename -> target membership from 001 §2.D (1045 entries, generated once
  from that doc, then hand-corrected alongside `explicit`). The test resolves
  every live root and nested `*.test.ts` basename through `resolveTarget` and
  asserts equality with the fixture entry by entry, then derives the per-domain
  histogram from the fixture and asserts it equals 001 §2.B. A swap between two
  domains fails the membership assertion; a resolver defect that moves and
  blesses the wrong target therefore fails here, not in the guard that shares the
  resolver. A new test file must be added to the fixture in the same PR.
- End-to-end on the temp copy: seed six fake files across two domains, run
  `move` with both domains, assert paths, rewritten imports, `migrated`, and that
  `verify` passes; then assert the layout guard passes on the result.

## 4. Verification for wp3

- `bun x tsc --noEmit` (root) and `bun x tsc --noEmit -p scripts/test-layout/tsconfig.verify.json`
  (covers `scripts/test-layout/**`, both `tests/test-layout*.test.ts`, `tests/helpers/**`; the
  root tsconfig excludes tests, so this is the only typecheck the tooling gets).
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/test-runner.test.ts tests/zz-ci-storage-policy-isolation.test.ts tests/zz-ci-api-usage-isolation.test.ts tests/repo-hygiene.test.ts tests/skill-ocx.test.ts tests/bun-runtime.test.ts tests/release-version-line.test.ts tests/ci-workflows.test.ts`
- `bun scripts/test-layout/plan.ts` exits 0 with zero UNRESOLVED (proves the map covers 1061).
- `bun scripts/test-layout/move.ts --domain windows --dry-run` prints the 20 moves and the rewrites without touching the tree.
- `bun run test:changed`, `bun run privacy:scan`.
- PR to `dev`, exact-head `ci` success, admin merge, ancestry proof.

