# 320-01 Bundled Bun — Research

## Problem

opencodex publishes to npm as `@bitkyc08/opencodex`. The `bin` entries point
directly at a TypeScript file with a Bun shebang:

```json
"bin": { "opencodex": "./src/cli.ts", "ocx": "./src/cli.ts" }
```

```ts
// src/cli.ts:1
#!/usr/bin/env bun
```

npm creates a bin shim that executes the target via its shebang. With
`#!/usr/bin/env bun`, a user who ran `npm install -g @bitkyc08/opencodex`
but does not have Bun on PATH gets:

```
env: bun: No such file or directory
```

Goal: npm users should NOT have to install Bun separately.

## Why plain Node can't just run it

The source is coupled to Bun beyond the shebang (8 call sites):

| Bun API | File | Note |
|---------|------|------|
| `Bun.serve` (+ WebSocket upgrade) | `src/server.ts`, `src/oauth/callback-server.ts` | proxy core + WS bridge |
| `Bun.file` | `src/server.ts` | GUI static serving |
| `Bun.sleep` | `src/server.ts` | trivial |
| `bun:sqlite` `Database` | `src/codex-history-provider.ts` | session history migrator |
| `.ts` direct execution | bin entry | Node can't run `.ts` reliably |

So "just run it with Node" = a full port (a separate, larger effort —
tracked as the future Option 3). This devlog implements **Option 1**:
keep the Bun runtime, but bundle it so the user never installs it.

## Option 1 — bundle `bun` as an npm dependency

### How the `bun` npm package works (verified)

`npm view bun` (v1.3.14):

```
bin: { bun: 'bin/bun.exe', bunx: 'bin/bunx.exe' }
scripts: { postinstall: 'node install.js' }
deps: none
unpackedSize: 20.8 kB     ← main package is tiny
optionalDependencies:
  @oven/bun-darwin-aarch64, @oven/bun-darwin-x64, @oven/bun-darwin-x64-baseline,
  @oven/bun-linux-aarch64, @oven/bun-linux-x64, @oven/bun-linux-x64-baseline,
  @oven/bun-linux-aarch64-musl, @oven/bun-linux-x64-musl, @oven/bun-linux-x64-musl-baseline,
  @oven/bun-linux-aarch64-android, @oven/bun-linux-x64-android,
  @oven/bun-freebsd-aarch64, @oven/bun-freebsd-x64,
  @oven/bun-windows-x64, @oven/bun-windows-x64-baseline, @oven/bun-windows-aarch64
```

This is the **esbuild/biome/turbo pattern**: a tiny main package +
platform-specific binaries published as `optionalDependencies`, with npm's
`os`/`cpu`/`libc` resolution picking the right one. `postinstall: node
install.js` finalizes the binary into the main package's `bin/`.

### Empirically verified facts (Backend employee, npm pack)

1. **Binary path is `node_modules/bun/bin/bun.exe` on ALL platforms** —
   including macOS and Linux, not just Windows. My original proposal said
   `bin/bun` (+`.exe` on win32); that was wrong. Resolve `bun.exe`.
2. `npm install --ignore-scripts` leaves a **0-byte placeholder** `bun.exe`
   until `install.js` runs. Launcher must guard against this.
3. `npm config set optional false` / `--omit=optional` skips the platform
   package → install likely fails. Document as a known constraint.
4. Bun's own package manager does NOT run dependency lifecycle scripts
   unless the dependency is in `trustedDependencies`. So `bun install` of
   opencodex needs `"trustedDependencies": ["bun"]` or the binary never
   downloads.
5. `require.resolve('bun/package.json')` from a launcher inside the same
   package resolves the nested dependency correctly → robust way to find
   the bun dir without hardcoding `@oven/bun-<platform>`.

### Launcher resolution strategy

```
bin/ocx.mjs  (#!/usr/bin/env node)
  → resolveBundledBun():
      bunDir   = dirname(require.resolve('bun/package.json'))
      bunBin   = join(bunDir, 'bin', 'bun.exe')   // all platforms
      if !existsSync(bunBin) or 0 bytes:
          run `node <bunDir>/install.js` (lazy fallback)
      return bunBin
  → spawnSync(bunBin, [join(__dirname,'..','src','cli.ts'), ...argv.slice(2)],
              { stdio: 'inherit' })
  → propagate signal/exit code
```

`process.execPath` inside `cli.ts` stays = the bun binary (because the
launcher execs bun to run cli.ts). This is critical — see §Ripple effects.

## Ripple effects on existing code

| File:line | Current | Impact |
|-----------|---------|--------|
| `src/service.ts:18-20` | `{ bun: process.execPath, cli: join(import.meta.dir,'cli.ts') }` baked into launchd/systemd/schtasks | `process.execPath` still = bun → works. But must bake the BUNDLED bun, not a system bun (see C2). |
| `src/codex-shim.ts:39-40` | same pattern baked into codex auto-start shim | same |
| `src/update.ts:12-15` | `HERE.includes('.bun') ? 'bun' : 'npm'` | npm global path has no `.bun` → correctly picks `npm`. Bundled bun under `node_modules/bun/` does NOT change `HERE`. ✓ |
| `src/cli.ts:239,489` | `spawn(process.execPath, [process.argv[1],'start'])` | still spawns bun + cli.ts ✓ |
| `tests/startup-prompt.test.ts:10-17` | asserts opencodex ships NO postinstall | Option 1 relies on the BUN dependency's postinstall, not opencodex's. Do NOT add an opencodex postinstall. ✓ |

## Tradeoffs

- Every install downloads ~60 MB platform binary (even users who already
  have system bun, since it's a hard dependency).
- `--ignore-scripts` / `--omit=optional` installs need the lazy fallback +
  actionable error message.
- This does NOT remove the Bun runtime — it removes the manual install step.
  A true Node port (Option 3) is a separate future effort.

## Sources

- Bun single-file executable docs: https://bun.com/docs/bundler/executables
- bun npm package: https://www.npmjs.com/package/bun
- esbuild platform-specific binaries (the canonical pattern):
  https://github.com/evanw/esbuild/blob/main/lib/npm/node-platform.ts
- Publishing binaries on npm (Sentry): https://sentry.engineering/blog/publishing-binaries-on-npm
- bun build --compile external-asset caveat (relevant to future Option 2):
  https://github.com/oven-sh/bun/issues/14676
