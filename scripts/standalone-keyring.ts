import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { keyringAssetForStandaloneTarget } from "../src/lib/keyring-native";

/** Stage the platform N-API addon outside Bun's virtual filesystem beside a standalone binary. */
export function stageStandaloneKeyringAddon(repoRoot: string, output: string, target: string): string {
  const asset = keyringAssetForStandaloneTarget(target);
  if (!asset) throw new Error(`No keyring native asset is declared for standalone target ${target}`);
  // Resolve optional target packages from their declaring wrapper. This preserves the lockfile
  // relationship without depending on Bun/npm/pnpm choosing a particular hoisting layout.
  const projectRequire = createRequire(join(repoRoot, "package.json"));
  const keyringRequire = createRequire(projectRequire.resolve("@napi-rs/keyring"));
  let source: string;
  try {
    source = keyringRequire.resolve(asset.packageName);
  } catch {
    throw new Error(
      `Missing ${asset.packageName}/${asset.filename}; install target optional dependencies before building ${target}`,
    );
  }
  if (basename(source) !== asset.filename || !existsSync(source)) {
    throw new Error(`Resolved ${asset.packageName} to an unexpected native asset: ${source}`);
  }
  const keyringDir = join(output, "keyring");
  mkdirSync(keyringDir, { recursive: true });
  const destination = join(keyringDir, asset.filename);
  copyFileSync(source, destination);
  return destination;
}
