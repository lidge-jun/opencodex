# 030 — launchd stable-launcher parity (#3464)

Work-phase: one full PABCD cycle. Refs #3464 (does not close: the PR fixes which version the *next* launchd start runs; an already-running stale proxy after an external upgrade is a separate product decision — auto-repair vs refuse — left open on the issue).
Source evidence lane output is reproduced below verbatim (diff-level). Stale-check
against the current tree at this cycle's P before implementing.

---

1) VERDICT: FIXABLE

Launchd parity is **not fixed**. The stable launcher fixes which version starts next; it does **not** replace an already-running proxy after `mise upgrade`.

2) EVIDENCE

Checkout HEAD is `6d9639165581546cdcebe96bc911446caabdd7d0`. Contrary to the supplied premise, local `origin/dev` is now `980a9fbede123f411f52c8b061a05fb995ae159d`. `git diff HEAD origin/dev -- src/service.ts tests/service/service.test.ts` is empty.

Current code:

- [src/service.ts:73](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:73): `cli: join(import.meta.dir, "cli", "index.ts")`.
- [src/service.ts:490](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:490): `const { bun, bunRuntimeSource, cli } = cliEntry();`
- [src/service.ts:507](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:507): `const command = buildServiceShellCommand(bun, cli);`
- [src/service.ts:515](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:515): ProgramArguments remain `/bin/sh`, `-lc`, `${plistString(command)}`.
- [src/service.ts:498](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:498): plist also stamps `${BUN_RUNTIME_SOURCE_ENV}` and `${BUN_RUNTIME_PATH_ENV}`.
- [src/service.ts:2254](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:2254): `writeServiceDefinitionFile(p, buildPlist(), "utf8");`; line 2271 records `writeServiceInstallState();` without a launcher.
- Linux already selects the alternate command at [src/service.ts:3301](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:3301): `launcher ? buildServiceLauncherShellCommand(launcher) : buildServiceShellCommand(bun, cli)`.
- Launcher-aware stale-path detection already exists at [src/service.ts:3244](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts:3244): `if (state?.launcherPath) { if (existsSync(state.launcherPath)) return null; ... }`.

Linux precedent, verified through GitHub and `git log origin/dev`:

- [#2898](https://github.com/lidge-jun/opencodex/issues/2898) is the closed Linux issue, not a PR.
- [#2909](https://github.com/lidge-jun/opencodex/pull/2909), merged `4ec1cc9585456eac95f9c9d679b61380496d6d9d`, explicitly says “launchd and Windows service generation untouched.”
- [#2916](https://github.com/lidge-jun/opencodex/pull/2916), merged `fe05b0ae2c479056099c77185dba63d101e46f80`, hardens executable discovery, deterministic builders, and trusted Bun overrides.

`git log origin/dev --since=2026-09-01 -- src/service.ts` contains only `ea29e25b0` (#3186), `b14b741dc` (#3134), and `330470e74` (#3118): wait accounting, Windows startup, and typed stop outcomes—not launchd launcher parity.

3) DIFF-LEVEL PLAN

**MODIFY [src/service.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/service.ts)**

Mirror `buildUnit`’s explicit dependencies; resolve the launcher once during installation:

```diff
-export function buildPlist(proxyEnv: { name: string; value: string }[] = resolvedProxyEnv()): string {
-  const { bun, bunRuntimeSource, cli } = cliEntry();
+export function buildPlist(
+  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
+  deps: { launcher?: string | null; runtime?: DurableBunRuntime } = {},
+): string {
+  const runtime = deps.runtime ?? durableBunRuntime();
+  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
+  const launcher = deps.launcher ?? null;
```

Replace the two unconditional runtime environment entries:

```diff
-    `    <key>${BUN_RUNTIME_SOURCE_ENV}</key><string>${bunRuntimeSource}</string>`,
-    `    <key>${BUN_RUNTIME_PATH_ENV}</key><string>${plistString(bun)}</string>`,
+    ...(launcher ? [] : [
+      `    <key>${BUN_RUNTIME_SOURCE_ENV}</key><string>${bunRuntimeSource}</string>`,
+      `    <key>${BUN_RUNTIME_PATH_ENV}</key><string>${plistString(bun)}</string>`,
+    ]),
+    launcher && runtime.source === "override"
+      ? `    <key>${runtime.overrideEnv}</key><string>${plistString(runtime.path)}</string>`
+      : null,
```

Preserve the existing shell wrapper, XML escaping, token-file preamble, port and home environment:

```diff
-  const command = buildServiceShellCommand(bun, cli);
+  const command = launcher
+    ? buildServiceLauncherShellCommand(launcher)
+    : buildServiceShellCommand(bun, cli);
```

In `installLaunchd()`:

```diff
-  writeServiceDefinitionFile(p, buildPlist(), "utf8");
+  const launcher = stableLauncherEntry();
+  writeServiceDefinitionFile(p, buildPlist(resolvedProxyEnv(), { launcher }), "utf8");
   // Existing unload/load and failure checks remain unchanged.
-  writeServiceInstallState();
+  writeServiceInstallState("scheduler", launcher);
```

Update Linux-only comments at lines 77 and 208 to cover launchd/systemd. No state-schema change or new diagnostic implementation is needed.

**MODIFY [tests/service/service.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/service/service.test.ts)**

Extend existing `describe("launchd service plist")` at line 1049. Adapt the Linux regression at line 1159:

```ts
test("launchd uses a stable launcher without pinning package paths (#3464)", () => {
  const plist = buildPlist(resolvedProxyEnv({}), {
    launcher: "/Users/test/.local/share/mise/shims/ocx",
    runtime: {
      path: "/opt/opencodex/versioned/bun",
      source: "bundled",
      overrideEnv: "OPENCODEX_BUN_PATH",
    },
  });
  expect(plist).toContain("/Users/test/.local/share/mise/shims/ocx");
  expect(plist).toContain("start --port");
  for (const forbidden of [
    "OCX_BUN_RUNTIME_PATH", "OCX_BUN_RUNTIME_SOURCE",
    "OPENCODEX_BUN_PATH", "/opt/opencodex/versioned/bun", "cli/index.ts",
  ]) expect(plist).not.toContain(forbidden);
  expectTextToContainPath(plist, serviceApiTokenFilePath());
  expect(launchdListenPort({ readPlist: () => plist }))
    .toBe(resolveServiceListenPort());
});
```

Also pin:

- `launcher: null` retains direct Bun/CLI and provenance markers.
- Launcher mode preserves **trusted** `OPENCODEX_BUN_PATH`, rejects unpaired ambient overrides; extend the existing provenance test at line 1050.
- Custom homes/proxy settings survive, and a sentinel API token never appears in the plist.
- Install source-order assertion mirrors lines 384–391: one discovery, same launcher passed to plist and state, state written only after successful load.
- Retargeted-shim case extends lines 1187–1232 to assert the plist names the unchanged shim before/after removing v1.
- Quoted launcher paths containing spaces, apostrophes and `&` remain valid shell/XML.

Platform convention: existing plist string tests are **cross-platform**, not Darwin-skipped. Only a new macOS-native parser/execution check should use `test.skipIf(process.platform !== "darwin")`, as in [tests/codex-integration/codex-log-guard-coderabbit.test.ts:111](/Users/jun/.codex/worktrees/ef41/opencodex/tests/codex-integration/codex-log-guard-coderabbit.test.ts:111). Do not invoke real launchctl from regression tests.

No NEW test file required: existing mappings are `"service.test.ts": "service"` in [layout.json:1056](/Users/jun/.codex/worktrees/ef41/opencodex/scripts/test-layout/layout.json:1056) and [test-layout-expected.json:893](/Users/jun/.codex/worktrees/ef41/opencodex/tests/fixtures/test-layout-expected.json:893). A separately named test would require both entries.

**Cheap optional diagnostic improvement**

Detection already exists; its message incorrectly assumes the CLI is stale. [src/cli/version-skew.ts:43](/Users/jun/.codex/worktrees/ef41/opencodex/src/cli/version-skew.ts:43) says:

```diff
- warning: `CLI ${cliVersion} does not match the running proxy ${proxy} — this ocx on PATH is stale. `
-   + "Its help and features describe a different build. Reinstall, or run the proxy's own binary.",
+ warning: `CLI ${cliVersion} does not match the running proxy ${proxy}. `
+   + "After upgrading OpenCodex, run 'ocx service repair' for an installed service, "
+   + "or restart a foreground proxy. If the CLI is older, check the ocx installation on PATH.",
```

If included, MODIFY [tests/cli/cli-version-skew.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/cli/cli-version-skew.test.ts): replace its `"stale"` assertion at line 17; test both version directions, particularly `2.42.0` versus `2.10.1-preview.20260805`. No new version parser or startup enforcement needed.

**Documentation**

- MODIFY [docs-site/src/content/docs/reference/cli/lifecycle.md:245](/Users/jun/.codex/worktrees/ef41/opencodex/docs-site/src/content/docs/reference/cli/lifecycle.md:245): “On Linux, the systemd unit…” → “On macOS and Linux, launchd and systemd service definitions…”.
- Replace line 256’s broad “subsequent version changes need no action” with: “After one repair migrates an old definition, subsequent starts follow the stable launcher. An already-running proxy still requires a restart after an external upgrade.”
- MODIFY [structure/04_transports-and-sidecars.md:36](/Users/jun/.codex/worktrees/ef41/opencodex/structure/04_transports-and-sidecars.md:36): generalize the Linux-only launcher contract to both POSIX service backends. Check translated lifecycle pages for contradictory claims.

Focused verification commands, **not executed**:

```sh
bun test tests/service/service.test.ts
bun test tests/cli/cli-version-skew.test.ts
```

Second command applies only if taking the optional wording change.

Risk: explicit security review is warranted under [MAINTAINERS.md:60](/Users/jun/.codex/worktrees/ef41/opencodex/MAINTAINERS.md:60). This changes durable executable selection and Bun override propagation adjacent to credential loading. Preserve absolute executable validation, lexical paths, shell/XML escaping, file-backed tokens and successful-load-before-state ordering.

4) OPEN QUESTIONS / RESIDUAL UNCERTAINTY

- Existing plists need one `ocx service repair`; the new generator cannot migrate them merely by being installed.
- Stable-launcher parity does **not** satisfy automatic repair/request refusal during an already-running version mismatch. That remains a separate product decision.
- Actual mise shim selection under launchd’s login-shell environment needs a macOS smoke check; no live service or real upgrade was exercised.
- Read-only investigation only: no files, Git state, GitHub comments, service state or tests were changed/run.
