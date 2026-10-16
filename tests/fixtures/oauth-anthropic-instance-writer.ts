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
let phase = "validate-isolation";

try {
  // Validate isolation before loading any runtime module that can read config/auth.
  if (!root || !isAbsolute(root) || (instance !== "anthropic" && instance !== "anthropic2")
    || !Number.isFinite(readyBudgetMs) || readyBudgetMs <= 0
    || process.env.HOME !== root || process.env.USERPROFILE !== root
    || process.env.OPENCODEX_HOME !== join(root, "ocx")
    || process.env.CLAUDE_CONFIG_DIR !== join(root, "claude")
    || process.env.CODEX_HOME !== join(root, "codex")
    || process.env.XDG_CONFIG_HOME !== join(root, "xdg")
    || [root, join(root, "ocx"), join(root, "claude"), join(root, "codex"), join(root, "xdg")].some(path => !existsSync(path))) {
    throw new Error("Invalid isolated writer setup");
  }
  watchdog = setTimeout(() => {
    process.stderr.write("Anthropic instance writer deadline exceeded\n");
    process.exit(1);
  }, readyBudgetMs + INTERNAL_DEADLINE_MS);
  globalThis.fetch = (async () => { throw new Error("Network forbidden in registration fixture"); }) as typeof fetch;

  const seededConfig = JSON.parse(readFileSync(join(root, "ocx", "config.json"), "utf8"));
  if (seededConfig.providers?.anthropic2?.anthropicOAuthInstance !== "anthropic2") {
    throw new Error("Writer requires an explicitly owned B seed before runtime imports");
  }

  phase = "import-store";
  const { getAuthStorePath, loadAuthStore, saveCredentialWithReceipt }: typeof import("../../src/oauth/store")
    = await import(repoPath("src", "oauth", "store.ts"));
  const { AnthropicCrossInstanceDuplicateError }: typeof import("../../src/oauth/store-anthropic-instance")
    = await import(repoPath("src", "oauth", "store-anthropic-instance.ts"));
  phase = "verify-store-path";
  if (getAuthStorePath() !== join(root, "ocx", "auth.json")) throw new Error("Auth store escaped isolation");
  phase = "read-seed";
  const credential = JSON.parse(readFileSync(join(root, `${instance}-credential.json`), "utf8")) as OAuthCredentials;
  phase = "load-store";
  const initialRows = Object.values(loadAuthStore()).flatMap(set => set.accounts).length;
  const readyPath = join(root, `${instance}-ready.json`);
  phase = "publish-ready";
  writeFileSync(`${readyPath}.tmp`, JSON.stringify({ pid: process.pid, instance, initialRows }));
  renameSync(`${readyPath}.tmp`, readyPath);

  const startPath = join(root, "start");
  const deadline = Date.now() + readyBudgetMs;
  // Poll an explicit barrier; elapsed time never substitutes for the start signal.
  phase = "wait-start";
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) throw new Error("Start barrier deadline exceeded");
    await Bun.sleep(10);
  }

  let result: AnthropicWriterResult;
  phase = "register";
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
} catch (error) {
  // Report phase and stack frames, never the exception message or credential data.
  if (root && isAbsolute(root) && (instance === "anthropic" || instance === "anthropic2")) {
    const name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : "Error";
    const frames = error instanceof Error ? (error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 4) ?? []) : [];
    try { writeFileSync(join(root, `${instance}-failure.json`), JSON.stringify({ phase, name, frames })); } catch { /* Parent retains the exit status. */ }
  }
  process.stderr.write("Anthropic instance writer failed\n");
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
