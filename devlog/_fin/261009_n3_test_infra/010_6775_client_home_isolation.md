# 010 — #6775: keep tests out of the real Claude config directory

## Defect

`tests/preload.ts` sandboxes a bare `bun test` by assigning `process.env.HOME`
after Bun has started. Bun's `os.homedir()` keeps the start-time home, so
`claudeConfigDir()` in `src/claude/gateway-cache.ts` resolves the developer's real
`~/.claude` when `CLAUDE_CONFIG_DIR` is unset. Management toggles call
`syncClaudeAgentDefsBestEffort()` (`src/server/management-api.ts`) with no
explicit directory, and `syncClaudeAgentDefs([])` prunes every generated
`ocx-*.md` there. `tests/claude-integration/claude-messages-endpoint.test.ts`
("compatibility survives management toggles…") triggers it.

Reproduced on `730d898457` with a temporary HOME at process start: a planted
generated `ocx-probe.md` in the fake home is removed by that one test.

## Change

### 1. Sandbox pins the Claude and Grok homes — MODIFY `scripts/test.ts`

`createIsolatedTestEnvironment()` already feeds both the wrapper child env and the
preload. Add, next to `CODEX_HOME`:

```diff
       OPENCODEX_HOME: opencodexHome,
       CODEX_HOME: codexHome,
+      // Client homes that default to os.homedir(). Bun keeps the start-time home, so a
+      // preload that only rewrites HOME leaves these pointing at the developer's real
+      // directories. Pin them inside the sandbox; never inherit a live override.
+      CLAUDE_CONFIG_DIR: join(root, ".claude"),
+      GROK_HOME: join(root, ".grok"),
```

and capture the real Claude directory for the guard before it is replaced:

```diff
       OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
+      OCX_REAL_CLAUDE_CONFIG_DIR: baseEnv.OCX_REAL_CLAUDE_CONFIG_DIR
+        ?? (baseEnv.CLAUDE_CONFIG_DIR?.trim() || join(baseEnv.OCX_REAL_HOME ?? homedir(), ".claude")),
```

### 2. Guard refuses the real Claude directory — MODIFY `src/lib/test-home-guard.ts`

Capture at module load (same moment as `REAL_HOME`), protecting the default
`<real home>/.claude` and, when it differs, the developer's own
`CLAUDE_CONFIG_DIR` handed over as `OCX_REAL_CLAUDE_CONFIG_DIR`:

```ts
const REAL_CLAUDE_DIRS = [...new Set([
  join(REAL_HOME, ".claude"),
  process.env.OCX_REAL_CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(REAL_HOME, ".claude"),
])];
const PROTECTED_CLAUDE_TREES = REAL_CLAUDE_DIRS.map(path => ({
  path: canonicalize(path), lexical: resolve(path), label: "the real Claude config directory",
}));

export function protectedClaudeConfigDirsForTests(): readonly string[];
/** Throw when an armed test process is about to write or prune inside the real Claude config dir. */
export function assertNotRealClaudeConfigUnderTest(dir: string): void;
```

`assertNotRealClaudeConfigUnderTest` is a no-op unless armed, and refuses when
`dir` (canonical or lexical) equals or sits inside a protected Claude tree. The
Claude trees are appended to `PROTECTED_TREES` so `assertRemovalOutsideProtectedTrees`
refuses removals there too.

Note on the capture: under `bun run test` the wrapper child already has a
sandboxed `CLAUDE_CONFIG_DIR`, which is why the real value travels in
`OCX_REAL_CLAUDE_CONFIG_DIR`. Under a bare run the preload imports the guard
before it rewrites the environment, so `process.env.CLAUDE_CONFIG_DIR` is still
the developer's own value.

### 3. Writers call the guard first — MODIFY `src/claude/agents-inject.ts`, `src/claude/gateway-cache.ts`

```diff
 export function syncClaudeAgentDefs(defs, configDir = claudeConfigDir()) {
+  // Outside the best-effort catch: under an armed test process a write or prune of the
+  // real Claude directory must fail loudly, never degrade to "returned null".
+  assertNotRealClaudeConfigUnderTest(configDir);
   try {
```

Same first line in `writeGatewayModelCache`. Callers that wrap these in their own
best-effort catch still never reach the filesystem.

### 4. Claude default home follows the current environment — MODIFY `src/claude/gateway-cache.ts`

```diff
 export function claudeConfigDir(): string {
   const custom = process.env.CLAUDE_CONFIG_DIR;
-  return custom && custom.length > 0 ? custom : join(homedir(), ".claude");
+  return custom && custom.length > 0 ? custom : join(currentUserHome(), ".claude");
 }
+
+/**
+ * The home Claude Code itself resolves. Claude Code runs on Node, whose os.homedir()
+ * consults HOME (POSIX) or USERPROFILE (Windows) at call time when it is set; Bun's
+ * caches the start-time value. In production the two agree; under a preload that
+ * rewrites HOME only this one follows the sandbox. Exported as an internal for tests.
+ */
+export function currentUserHome(env = process.env, platform = process.platform): string {
+  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
+  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : homedir();
+}
```

### 5. Existing resolver test follows the new contract — MODIFY `tests/claude-integration/claude-gateway-cache.test.ts`

"claudeConfigDir honors CLAUDE_CONFIG_DIR" deletes `CLAUDE_CONFIG_DIR` and expects
`join(os.homedir(), ".claude")`, Bun's cached start-time home. Under the preload that is the
developer's real home, so the assertion encodes the defect. New fallback expectation:

```diff
-      const { homedir } = require("node:os") as typeof import("node:os");
-      expect(claudeConfigDir()).toBe(join(homedir(), ".claude"));
+      const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
+      expect(claudeConfigDir()).toBe(join(home!, ".claude"));
```

### 6. The triggering test names its directory — MODIFY `tests/claude-integration/claude-messages-endpoint.test.ts`

Pass `{ managementApi: { claudeAgentConfigDir: join(testDir, "claude-agents") } }`
to `startServer` in the toggle test (in-place, no line growth; file is at 1993/2000).

## Regression tests — NEW `tests/claude-integration/claude-config-home-isolation.test.ts`

1. `createIsolatedTestEnvironment({ CLAUDE_CONFIG_DIR: "/inherited", GROK_HOME: "/inherited" })`
   pins both inside `isolated.root` and records `OCX_REAL_CLAUDE_CONFIG_DIR: "/inherited"`.
   Fails on dev (inherited values pass through).
2. With `CLAUDE_CONFIG_DIR` unset and `HOME`/`USERPROFILE` reassigned in-process,
   `claudeConfigDir()` returns `<new home>/.claude`. Fails on dev under Bun.
3. A child Bun process armed with `OCX_TEST_HOME_GUARD=1` and
   `OCX_REAL_HOME=<temp sentinel>` calls `syncClaudeAgentDefs([], <sentinel>/.claude)`:
   the call throws the guard error and the planted generated file survives. On dev
   the file is pruned. The sentinel is a temp directory, so the real home is never
   involved.
4. The preload itself: inside any test process, `process.env.CLAUDE_CONFIG_DIR`
   resolves under the sandbox root, not under `OCX_REAL_HOME`.
5. HOME and USERPROFILE disagree: `currentUserHome({HOME:a, USERPROFILE:b}, "linux")`
   is `a`, with `"win32"` it is `b`, and an empty variable falls back to `os.homedir()`.
6. Nested isolation keeps the original: `createIsolatedTestEnvironment(isolated.env)`
   preserves the outer `OCX_REAL_CLAUDE_CONFIG_DIR`.

Register the new file in `scripts/test-layout/layout.json` (`explicit`) and
`tests/fixtures/test-layout-expected.json` under `claude-integration`.

Extend `tests/ci-workflows/test-home-guard.test.ts` only if its roster asserts the
exact protected-tree list (check `protectedRemovalTreesForTests` expectations).

## Structure docs

Source areas touched: `scripts/`, `src/claude/`, `src/lib/`, `tests/`. Every doc mapped for
them in `structure/INDEX.md` is reviewed. The contract that changes is the test sandbox,
described by `structure/ops/test-sandbox-cleanup.md` (maps `tests/`). MODIFY it with one
present-tense paragraph: the sandbox pins `CLAUDE_CONFIG_DIR` and `GROK_HOME` inside its
root and hands the real Claude directory to the guard as `OCX_REAL_CLAUDE_CONFIG_DIR`;
`claudeConfigDir()` follows the current platform home variable; the armed guard refuses
Claude agent sync and gateway-cache writes into the real Claude config directory (default and
the developer's own `CLAUDE_CONFIG_DIR`) and refuses removals there; pinned by
`tests/claude-integration/claude-config-home-isolation.test.ts`. The other mapped docs
(`runtime.md`, `clients/claude-desktop.md`, `overview.md`, `ops/docs-and-release.md`, and the
`src/lib/` transport/dashboard docs) describe no behavior this change alters; the PR records
that review.

## Out of scope, reported in the PR

The research inventory found other client homes resolved through `homedir()`
(Claude Desktop config library, client integration writers, Kiro, XDG-based
clients). The sandbox now pins Claude and Grok; the rest are follow-up candidates.

## Verify

```sh
FH=$(mktemp -d); env -u CLAUDE_CONFIG_DIR -u GROK_HOME HOME="$FH" USERPROFILE="$FH" CLAUDE_CONFIG_DIR="$FH/.claude" \
  bun test tests/claude-integration/claude-config-home-isolation.test.ts tests/ci-workflows/test-home-guard.test.ts \
  tests/claude-integration/claude-messages-endpoint.test.ts tests/claude-integration/claude-agents-inject.test.ts \
  tests/claude-integration/claude-gateway-cache.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts \
  tests/ci-workflows/structure-ssot.test.ts tests/ci-workflows/file-size-ratchet.test.ts
bun run typecheck
bun run structure:check
```
plus the issue's probe: plant a generated `ocx-probe.md` in `$FH/.claude/agents`,
start Bun with `CLAUDE_CONFIG_DIR` unset, and confirm it survives.


## Implementation record

Merged as PR #6835 (`7f642e30e8`). Beyond this doc, review added: guarded served-catalog
invalidation (`src/claude/intercept/cli-catalog.ts`) and the intercept `settings.json`
writer (`src/claude/intercept/settings.ts`); every touched path, including
`cache/gateway-models.json` and each agent definition's temporary file, is passed to the
guard; roots resolve at check time with case folding on macOS and Windows; removal
protection uses the same comparison and keeps the checkout-content lift. The regression file
has eight cases, all failing on `dev` before the change.

