import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OcxConfig } from "../../src/types";
import type { AnthropicWriterResult } from "../fixtures/oauth-anthropic-instance-writer";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { COLD_SPAWN_BUDGET_MS, INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const instances = ["anthropic", "anthropic2"] as const;

function credential(label: string): OAuthCredentials {
  return {
    access: `synthetic-multiprocess-${label}-access`,
    refresh: `synthetic-multiprocess-${label}-refresh`,
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-shared-display-id",
    source: "oauth",
  };
}

async function bounded<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Anthropic registration ${phase} deadline exceeded`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  // Allow only OS execution variables, never inherited provider credentials/config roots.
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    HOME: root,
    USERPROFILE: root,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    OPENCODEX_HOME: join(root, "ocx"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    OCX_TEST_HOME_GUARD: "1",
  };
}

function prepareStore(root: string, values: readonly [OAuthCredentials, OAuthCredentials]): string {
  const ocx = join(root, "ocx");
  mkdirSync(ocx, { mode: 0o700 });
  mkdirSync(join(root, "claude"), { mode: 0o700 });
  mkdirSync(join(root, "codex"), { mode: 0o700 });
  mkdirSync(join(root, "xdg"), { mode: 0o700 });
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "anthropic",
    providers: Object.fromEntries(instances.map(instance => [instance, {
      adapter: "anthropic" as const, authMode: "oauth" as const, baseUrl: "https://api.anthropic.com",
      ...(instance === "anthropic2" ? { anthropicOAuthInstance: "anthropic2" as const } : {}),
      models: ["claude-sonnet-4-6"],
    }])),
  };
  const configBytes = JSON.stringify(config) + "\n";
  writeFileSync(join(ocx, "config.json"), configBytes, { mode: 0o600 });
  writeFileSync(join(ocx, "auth.json"), "{}\n", { mode: 0o600 });
  // Even an accidental local-token detector has a synthetic file, avoiding Keychain fallback.
  writeFileSync(join(root, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-cli-access", refreshToken: "synthetic-cli-refresh", expiresAt: Date.now() + 3_600_000,
  } }), { mode: 0o600 });
  instances.forEach((instance, index) => {
    writeFileSync(join(root, `${instance}-credential.json`), JSON.stringify(values[index]), { mode: 0o600 });
  });
  return configBytes;
}

async function runWriters(values: readonly [OAuthCredentials, OAuthCredentials], readyBudgetMs: number) {
  const root = mkdtempSync(join(tmpdir(), "ocx-anthropic-instance-multiprocess-"));
  const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
  try {
    const configBytes = prepareStore(root, values);
    const output = instances.map(instance => {
      const child = Bun.spawn([
        process.execPath, fixturePath("oauth-anthropic-instance-writer.ts"), root, instance, String(readyBudgetMs),
      ], { cwd: repoPath(), env: isolatedEnvironment(root), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      children.push(child);
      // Drain immediately so a logging regression cannot block the child on a full pipe.
      const captured = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      // The ready-barrier failure path still owns teardown, even if a stream rejects early.
      void captured.catch(() => {});
      return captured;
    });
    const readyPaths = instances.map(instance => join(root, `${instance}-ready.json`));
    const deadline = Date.now() + readyBudgetMs;
    while (!readyPaths.every(path => existsSync(path))) {
      if (children.some(child => child.exitCode !== null || child.signalCode !== null)) {
        const diagnostics = children.map((child, index) => {
          const path = join(root, `${instances[index]}-failure.json`);
          return { instance: instances[index], exitCode: child.exitCode, signalCode: child.signalCode,
            failure: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null };
        });
        throw new Error(`Anthropic registration writer exited before start barrier: ${JSON.stringify(diagnostics)}`);
      }
      if (Date.now() >= deadline) throw new Error("Anthropic registration ready barrier deadline exceeded");
      await Bun.sleep(10);
    }
    const ready = readyPaths.map(path => JSON.parse(readFileSync(path, "utf8")) as {
      pid: number; instance: AnthropicInstanceId; initialRows: number;
    });
    ready.forEach((row, index) => {
      expect(row).toEqual({ pid: children[index]!.pid, instance: instances[index], initialRows: 0 });
      expect(row.pid).not.toBe(process.pid);
    });
    expect(new Set(ready.map(row => row.pid)).size).toBe(2);
    expect(readFileSync(join(root, "ocx", "auth.json"), "utf8")).toBe("{}\n");
    writeFileSync(join(root, "start"), "start\n");

    const finished = await bounded(Promise.all(output), INTERNAL_DEADLINE_MS, "completion");
    finished.forEach(([exitCode, stdout, stderr]) => {
      expect(exitCode).toBe(0);
      // Assert lengths so even a failing logging check does not print credential text.
      expect(stdout.length).toBe(0);
      expect(stderr.length).toBe(0);
    });
    const results = instances.map(instance => JSON.parse(readFileSync(join(root, `${instance}-result.json`), "utf8")) as AnthropicWriterResult);
    results.forEach((row, index) => {
      expect(row.pid).toBe(children[index]!.pid);
      expect(row.instance).toBe(instances[index]);
    });
    // Parse disk bytes directly: normalization must not conceal a lost/corrupt row.
    const store = JSON.parse(readFileSync(join(root, "ocx", "auth.json"), "utf8")) as AuthStore;
    expect(store !== null && typeof store === "object" && !Array.isArray(store)).toBe(true);
    expect(readFileSync(join(root, "ocx", "config.json"), "utf8")).toBe(configBytes);
    return { results, store };
  } finally {
    try {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* Reap below distinguishes an exit race from a live child. */ }
        }
      }
      await bounded(Promise.all(children.map(child => child.exited)), INTERNAL_DEADLINE_MS, "cleanup");
    } finally {
      removeTreeWithRetry(root);
    }
  }
}

test("AUTH-11: cross-process duplicate registration into A/B admits exactly one credential", async () => {
  const shared = credential("duplicate");
  // The first pair includes the cold runtime import; subsequent readiness uses the normal bound.
  const { results, store } = await runWriters([shared, shared], COLD_SPAWN_BUDGET_MS);
  expect(results.filter(row => row.status === "success")).toHaveLength(1);
  const refusals = results.filter(row => row.status === "duplicate");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toMatchObject({
    name: "AnthropicCrossInstanceDuplicateError", code: "ANTHROPIC_CROSS_INSTANCE_DUPLICATE",
  });
  const winner = results.find(row => row.status === "success")!;
  expect(Object.keys(store)).toEqual([winner.instance]);
  expect(Object.values(store).flatMap(set => set.accounts)).toHaveLength(1);
  const set = store[winner.instance]!;
  expect(set.accounts[0]!.credential).toEqual(shared);
  expect(set.activeAccountId).toBe(set.accounts[0]!.id);
  expect(store[refusals[0]!.instance]).toBeUndefined();
}, COLD_SPAWN_BUDGET_MS + SPAWN_BUDGET_MS);

test("AUTH-11: distinct cross-process credentials sharing a stored id preserve both namespaces", async () => {
  const values: [OAuthCredentials, OAuthCredentials] = [credential("a"), credential("b")];
  const { results, store } = await runWriters(values, INTERNAL_DEADLINE_MS);
  expect(results.map(row => row.status)).toEqual(["success", "success"]);
  expect(Object.keys(store).sort()).toEqual([...instances].sort());
  expect(Object.values(store).flatMap(set => set.accounts)).toHaveLength(2);
  instances.forEach((instance, index) => {
    const set = store[instance]!;
    expect(set.accounts).toHaveLength(1);
    expect(set.accounts[0]!.credential).toEqual(values[index]);
    expect(set.activeAccountId).toBe(set.accounts[0]!.id);
  });
  expect(store.anthropic!.accounts[0]!.id).toBe(store.anthropic2!.accounts[0]!.id);
}, SPAWN_BUDGET_MS);
