import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OAuthCredentials } from "../../src/oauth/types";
import { repoPath } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

export type AnthropicWriterResult = {
  pid: number;
  instance: AnthropicInstanceId;
} & ({ status: "success" } | {
  status: "duplicate";
  name: string;
  code: string;
});

const [root, instance, readyBudget] = process.argv.slice(2);
const readyBudgetMs = Number(readyBudget);
let watchdog: ReturnType<typeof setTimeout> | undefined;

try {
  // Validate isolation before loading any runtime module that can read config/auth.
  if (!root || !isAbsolute(root) || (instance !== "anthropic" && instance !== "anthropic2")
    || !Number.isFinite(readyBudgetMs) || readyBudgetMs <= 0
    || process.env.HOME !== root || process.env.USERPROFILE !== root
    || process.env.OPENCODEX_HOME !== join(root, "ocx")
    || process.env.CLAUDE_CONFIG_DIR !== join(root, "claude")) {
    throw new Error("Invalid isolated writer setup");
  }
  watchdog = setTimeout(() => {
    process.stderr.write("Anthropic instance writer deadline exceeded\n");
    process.exit(1);
  }, readyBudgetMs + INTERNAL_DEADLINE_MS);
  globalThis.fetch = (async () => { throw new Error("Network forbidden in registration fixture"); }) as typeof fetch;

  const { getAuthStorePath, loadAuthStore, saveCredentialWithReceipt }: typeof import("../../src/oauth/store")
    = await import(repoPath("src", "oauth", "store.ts"));
  const { AnthropicCrossInstanceDuplicateError }: typeof import("../../src/oauth/store-anthropic-instance")
    = await import(repoPath("src", "oauth", "store-anthropic-instance.ts"));
  if (getAuthStorePath() !== join(root, "ocx", "auth.json")) throw new Error("Auth store escaped isolation");
  const credential = JSON.parse(readFileSync(join(root, `${instance}-credential.json`), "utf8")) as OAuthCredentials;
  const initialRows = Object.values(loadAuthStore()).flatMap(set => set.accounts).length;
  const readyPath = join(root, `${instance}-ready.json`);
  writeFileSync(`${readyPath}.tmp`, JSON.stringify({ pid: process.pid, instance, initialRows }));
  renameSync(`${readyPath}.tmp`, readyPath);

  const startPath = join(root, "start");
  const deadline = Date.now() + readyBudgetMs;
  // Poll an explicit barrier; elapsed time never substitutes for the start signal.
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) throw new Error("Start barrier deadline exceeded");
    await Bun.sleep(10);
  }

  let result: AnthropicWriterResult;
  try {
    const receipt = await saveCredentialWithReceipt(instance, credential);
    if (!receipt) throw new Error("Synthetic credential was not registered");
    result = { pid: process.pid, instance, status: "success" };
  } catch (error) {
    if (!(error instanceof AnthropicCrossInstanceDuplicateError)) throw error;
    result = { pid: process.pid, instance, status: "duplicate", name: error.name, code: error.code };
  }
  // Only typed outcome metadata crosses the process boundary; no token/error dump.
  writeFileSync(join(root, `${instance}-result.json`), JSON.stringify(result));
  const { flushConfigDirHardeningAndReaps } = await import(repoPath("src", "config", "paths.ts"));
  await flushConfigDirHardeningAndReaps(join(root, "ocx"));
} catch {
  process.stderr.write("Anthropic instance writer failed\n");
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
