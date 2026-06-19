#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the npm tarball.
 *
 * Usage:
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish]
 *       Preflight (clean tree on main + typecheck) → bump package.json → commit → push →
 *       dispatch the Release workflow → watch it. Dry-run by default; pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts 0.1.0            # dry-run release of 0.1.0
 *           bun scripts/release.ts 0.1.0 --publish  # actually publish 0.1.0
 *
 * Requires: gh CLI (authed). Publishing is tokenless via Trusted Publishing (OIDC) — no NPM_TOKEN.
 */
import { $ } from "bun";

const args = process.argv.slice(2);

async function watchLatest(): Promise<void> {
  const id = (await $`gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId'`.text()).trim();
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  console.log(`→ watching Release run ${id}`);
  await $`gh run watch ${id} --exit-status --interval 10`;
}

if (args[0] === "watch") {
  await watchLatest();
  process.exit(0);
}

const version = args[0];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/release.ts <version> [--tag latest|preview] [--publish]\n       bun scripts/release.ts watch");
  process.exit(1);
}
const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] ?? "latest") : "latest";
const dryRun = !args.includes("--publish");

// 1. Preflight — must be on a clean main, and typecheck must pass.
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") { console.error(`✗ must be on main (currently ${branch}).`); process.exit(1); }
if ((await $`git status --porcelain`.text()).trim()) { console.error("✗ working tree not clean — commit or stash first."); process.exit(1); }
console.log("→ typecheck");
await $`bun x tsc --noEmit`;

// 2. Bump package.json (no git tag — the workflow verifies against this version).
console.log(`→ bump package.json → ${version}`);
await $`npm version ${version} --no-git-tag-version`;

// 3. Commit + push the version bump.
await $`git add package.json`;
await $`git commit -m ${`release: v${version}`}`;
console.log("→ push origin main");
await $`git push origin main`;

// 4. Dispatch the Release workflow.
console.log(`→ dispatch Release (tag=${tag}, dry-run=${dryRun})`);
await $`gh workflow run release.yml -f version=${version} -f tag=${tag} -f dry-run=${String(dryRun)}`;
await Bun.sleep(4000);

// 5. Watch it.
await watchLatest();
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  npm install -g @bitkyc08/opencodex");
