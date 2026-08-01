# 320 Bundled Bun — npm install without separate Bun install

## Objective

Make `npm install -g @bitkyc08/opencodex` work on a machine that has only
Node (no Bun). Bundle the Bun runtime via the official `bun` npm package and
route the `ocx`/`opencodex` bin through a Node launcher shim that execs the
bundled Bun to run `src/cli.ts`.

Non-goal: porting opencodex off Bun (that is a separate future effort —
Option 3). The Bun runtime stays; only the **manual install step** is removed.

## Classification

C3 (cross-domain): touches packaging (`package.json`), a new bin launcher,
the service/codex-shim path baking, update advisory, CI, and docs.
Release-surface change → C4-level care on the publish/verify gate.

## Design (validated by Backend employee review)

```
npm install -g @bitkyc08/opencodex
  → installs `bun` dep + @oven/bun-<platform> (~60MB) via optionalDependencies
  → bun postinstall (node install.js) places binary at node_modules/bun/bin/bun.exe
  → npm links bin: ocx → bin/ocx.mjs  (#!/usr/bin/env node)

ocx start
  → bin/ocx.mjs resolves bundled bun (bun/package.json → bin/bun.exe)
  → guards: missing / 0-byte → run install.js once
  → spawnSync(bunBin, [src/cli.ts, ...args], {stdio:'inherit'})
  → process.execPath inside cli.ts == bun binary (service/shim keep working)
```

## Phase Map

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **Phase 1** | Launcher + packaging | `bin/ocx.mjs`, `package.json` (dep, bin, files, trustedDependencies, engines) |
| **Phase 2** | Shared bundled-bun resolver | `src/bun-runtime.ts`; wire `service.ts` + `codex-shim.ts` to bake bundled bun |
| **Phase 3** | Update advisory + CI smoke | `update.ts` repair advisory; npm-global CI job |
| **Phase 4** | Docs | README + docs-site: drop "install bun first" for npm users |

---

## Phase 1 — Launcher + Packaging

### 1.1 NEW `bin/ocx.mjs`

Node launcher. Resolves bundled bun, lazy-installs if missing, execs cli.ts,
propagates signal/exit code (C11).

```js
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.ts");

function resolveBundledBun() {
  const bunDir = dirname(require.resolve("bun/package.json"));
  // npm bun package ships the binary as bin/bun.exe on ALL platforms (verified)
  const bunBin = join(bunDir, "bin", "bun.exe");
  if (!existsSync(bunBin) || statSync(bunBin).size === 0) {
    // lazy fallback: --ignore-scripts or failed postinstall left a 0-byte stub (C7)
    const installJs = join(bunDir, "install.js");
    if (existsSync(installJs)) {
      const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
      if (r.status !== 0 || !existsSync(bunBin) || statSync(bunBin).size === 0) {
        fail();
      }
    } else {
      fail();
    }
  }
  return bunBin;
}

function fail() {
  console.error(
    "opencodex: bundled Bun runtime is missing.\n" +
    "This usually means the install skipped scripts or optional deps.\n" +
    "Reinstall without those flags:\n" +
    "  npm install -g @bitkyc08/opencodex   (no --ignore-scripts, no --omit=optional)"
  );
  process.exit(1);
}

const bunBin = resolveBundledBun();
const res = spawnSync(bunBin, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.error) { console.error(res.error.message); process.exit(1); }
if (res.signal) { process.kill(process.pid, res.signal); }
process.exit(res.status ?? 1);
```

### 1.2 MODIFY `package.json`

```jsonc
{
  // bin → Node launcher (was ./src/cli.ts)
  "bin": { "opencodex": "./bin/ocx.mjs", "ocx": "./bin/ocx.mjs" },

  // ship the launcher (C5)
  "files": ["bin", "src", "gui/dist", "README.md", "LICENSE"],

  // bundle the Bun runtime
  "dependencies": { "zod": "^4.0.0", "bun": "1.3.14" },

  // let `bun install` of opencodex run the bun dep's postinstall (C4)
  "trustedDependencies": ["bun"],

  // launcher needs Node; bun is no longer a user prerequisite (C6)
  "engines": { "node": ">=18" }
}
```

Keep `#!/usr/bin/env bun` on `src/cli.ts` — dev workflow (`bun run
src/cli.ts`) is unchanged; only the published `bin` routes through the
launcher (C-alt-4).

Do NOT add an opencodex-level `postinstall` — `tests/startup-prompt.test.ts`
asserts there is none, and the bun dependency's own postinstall is what we
rely on (C12).

---

## Phase 2 — Shared Bundled-Bun Resolver

### 2.1 NEW `src/bun-runtime.ts`

Single source of truth for "where is the bundled bun". Used by the launcher
concept AND by service/shim baking so long-lived artifacts always point at
the bundled binary, never a transient system bun (C2/C3).

```ts
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Absolute path to the bundled Bun binary, or null if unresolved. */
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    const bin = join(bunDir, "bin", "bun.exe");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Bun path to bake into durable artifacts (launchd/systemd/schtasks/codex-shim).
 * Prefer the bundled binary; fall back to the current runtime (process.execPath)
 * which is itself bun when launched normally.
 */
export function durableBunPath(): string {
  return bundledBunPath() ?? process.execPath;
}
```

### 2.2 MODIFY `src/service.ts` (line ~18-20)

```ts
// BEFORE
function cliEntry() {
  return { bun: process.execPath, cli: join(import.meta.dir, "cli.ts") };
}
// AFTER
import { durableBunPath } from "./bun-runtime";
function cliEntry() {
  return { bun: durableBunPath(), cli: join(import.meta.dir, "cli.ts") };
}
```

### 2.3 MODIFY `src/codex-shim.ts` (`cliEntry()`, line ~45-46)

Same one-line swap to `durableBunPath()`.

Note (post-rebase onto dev `b63f5c8` "harden Windows Codex integration"):
codex-shim now has THREE shim builders — `buildUnixCodexShim`,
`buildWindowsCodexShim`, and the new `buildWindowsPowerShellCodexShim` —
all receiving `bunPath` from the single `cliEntry()`. So fixing `cliEntry()`
covers all three automatically; no per-builder change needed.

Rationale: if a user later removes a standalone bun, the baked launchd/shim
path must still resolve. The bundled bun lives under the npm global prefix
and persists across `ocx update` (in-place content replacement).

---

## Phase 3 — Update Advisory + CI Smoke

### 3.1 MODIFY `src/update.ts` (success path, ~line 60-69)

After a successful `ocx update`, if a service or codex-shim is installed,
re-bake their paths (or advise). Today only the Windows shim is repaired.

```ts
// after successful update, before "Restart the proxy" message
if (serviceIsInstalled()) console.log("Service detected — refresh paths:  ocx service install");
if (codexShimIsInstalled()) console.log("Codex shim detected — refresh:    ocx codex-shim install");
```

(If `serviceIsInstalled()` / `codexShimIsInstalled()` helpers don't exist,
either add lightweight existence checks or print the advisory unconditionally.)

`detectInstall()` needs no change — npm global path has no `.bun` segment,
so it correctly returns `"npm"` and `ocx update` runs `npm install -g
@bitkyc08/opencodex@latest`, which re-pulls the bun dep.

### 3.2 NEW CI job — npm-global path (`.github/workflows/ci.yml`)

Current CI runs `bun run src/cli.ts` with setup-bun — it never exercises the
npm-only path (C9). Add a job with **no bun on PATH**:

```yaml
npm-global-smoke:
  strategy:
    matrix:
      os: [ubuntu-latest, windows-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 20 }
    - run: npm pack
    - run: npm install -g ./bitkyc08-opencodex-*.tgz
    - run: ocx help          # must succeed with NO bun on PATH
    - run: ocx status || true
```

---

## Phase 4 — Docs

### 4.1 MODIFY `README.md`

- Remove "Requires Bun 1.1+" / "bun must be on your PATH" for npm users.
- New install block:
  ```
  npm install -g @bitkyc08/opencodex
  ocx start
  ```
- Keep a "Dev from source" note that uses bun (`bun run src/cli.ts`).

### 4.2 MODIFY docs-site

Mirror the README change; drop the "install bun first" collapsible from the
npm install path.

---

## File Change Summary

| Action | File | Change |
|--------|------|--------|
| NEW | `bin/ocx.mjs` | Node launcher → bundled bun → cli.ts |
| NEW | `src/bun-runtime.ts` | `bundledBunPath()` / `durableBunPath()` |
| MODIFY | `package.json` | bin, files, dependencies(bun), trustedDependencies, engines |
| MODIFY | `src/service.ts` | bake `durableBunPath()` |
| MODIFY | `src/codex-shim.ts` | bake `durableBunPath()` |
| MODIFY | `src/update.ts` | post-update service/shim path advisory |
| MODIFY | `.github/workflows/ci.yml` | npm-global smoke job (no bun on PATH) |
| MODIFY | `README.md` + docs-site | drop "install bun first" for npm users |

## Risks & Mitigations (from employee review)

| # | Risk | Mitigation | Phase |
|---|------|-----------|-------|
| C1 | binary is `bin/bun.exe` on ALL platforms (not `bin/bun`) | launcher resolves `bun.exe` | 1 |
| C2 | "prefer system bun" breaks baked service/shim paths | bake bundled bun via `durableBunPath()` | 2 |
| C3 | baked paths not regenerated on update | post-update advisory / repair | 3 |
| C4 | `bun install` skips dep postinstall | `trustedDependencies: ["bun"]` | 1 |
| C5 | new launcher not published | add `bin` to `files` | 1 |
| C6 | `engines.bun` misleads npm-only users | add `node>=18`, drop `engines.bun` | 1 |
| C7 | `--ignore-scripts`/`--omit=optional` → 0-byte binary | launcher lazy `install.js` + actionable error | 1 |
| C8 | update misclassifies pnpm/yarn globals | out of scope; note only | — |
| C9 | no CI for npm-global path | add smoke job | 3 |
| C10 | docs still require standalone bun | update README/docs | 4 |
| C11 | launcher must propagate exit/signal | `spawnSync` + signal forward | 1 |
| C12 | repo forbids opencodex postinstall | rely on bun dep postinstall only | 1 |

## Verification Gate (C4-level — release surface)

1. `bun run typecheck` clean
2. `bun test` full suite green (existing 369 + any new)
3. Local pack smoke: `npm pack` → install the tarball into a Node-only
   shell (PATH stripped of bun) → `ocx help` / `ocx status` succeed
4. CI npm-global-smoke job green on ubuntu + windows
5. Only after all green: version bump + publish (existing release.ts gate)
