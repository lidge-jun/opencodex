import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Rust toolchain environment for tests that build or run native fixtures.
 *
 * The preload sandboxes HOME/USERPROFILE, and rustup finds its toolchains from RUSTUP_HOME, which
 * hosted runners leave unset. Guessing the home from OCX_REAL_HOME or userInfo() has failed on
 * Windows only when another file ran first in the same Bun process ("rustup could not choose a
 * version of cargo ... no default is configured"; batches 42499262970, 42580170093, 42672304851).
 * The rustup proxy's own location names the installation it belongs to, so derive both homes from
 * it, and fall back to the real-home guess only when the binary is not inside a .cargo/bin.
 */
export function rustToolchainEnv(tool: "cargo" | "rustc"): { bin: string | null; env: Record<string, string | undefined>; describe: () => string } {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const realHome = process.env.OCX_REAL_HOME?.trim() || userInfo().homedir;
  const found = Bun.which(tool) ?? join(realHome, ".cargo", "bin", `${tool}${exeSuffix}`);
  const bin = existsSync(found) ? found : null;
  let cargoHome = process.env.CARGO_HOME || join(realHome, ".cargo");
  let rustupHome = process.env.RUSTUP_HOME || join(realHome, ".rustup");
  if (bin && !process.env.CARGO_HOME && !process.env.RUSTUP_HOME) {
    let resolved = bin;
    try { resolved = realpathSync(bin); } catch { /* keep the PATH spelling */ }
    const binDir = dirname(resolved);
    if (basename(binDir) === "bin" && basename(dirname(binDir)) === ".cargo") {
      cargoHome = dirname(binDir);
      const sibling = join(dirname(cargoHome), ".rustup");
      if (existsSync(sibling)) rustupHome = sibling;
    }
  }
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome };
  const describe = () => JSON.stringify({
    bin, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    rustupSettings: existsSync(join(rustupHome, "settings.toml")),
    OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null, HOME: process.env.HOME ?? null,
  });
  return { bin, env, describe };
}

