import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "./remove-tree";

export async function withLocalCredentialFixture(work: (f: {
  home: string;
  codex: string;
  put(path: string, value: unknown): void;
  inventory: typeof import("../../src/local-credentials/inventory");
  publication: typeof import("../../src/local-credentials/generation");
  start(): ReturnType<typeof import("../../src/local-credentials/inventory").startLocalCredentialObservation>;
}) => Promise<void>): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-lc-")));
  const home = join(root, "ocx");
  const codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex);
  const prior = { ocx: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = codex;
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => ok);
  setAsyncIcaclsRunnerForTests(async () => ok);
  let owner: { stop(): void } | undefined;
  try {
    const inventory = await import("../../src/local-credentials/inventory");
    const publication = await import("../../src/local-credentials/generation");
    await work({
      home, codex, inventory, publication,
      put: (path, value) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); },
      start: () => { owner = inventory.startLocalCredentialObservation(); return owner as ReturnType<typeof inventory.startLocalCredentialObservation>; },
    });
  } finally {
    owner?.stop();
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
    if (prior.ocx === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior.ocx;
    if (prior.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior.codex;
    removeTreeWithRetry(root);
  }
}
