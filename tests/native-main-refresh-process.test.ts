import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidMainAccountToken } from "../src/codex/main-account";

let home = "";
let previousCodexHome: string | undefined;

type WorkerEvent = {
  event: "ready" | "refresh" | "result" | "fatal";
  pid: number;
  accessToken?: string;
  chatgptAccountId?: string;
  message?: string;
};

type Worker = {
  child: ReturnType<typeof Bun.spawn>;
  ready: Promise<WorkerEvent>;
  result: Promise<WorkerEvent>;
  events: WorkerEvent[];
  stdout: Promise<void>;
};

function spawnRefreshWorker(): Worker {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-main-refresh-process-worker.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CODEX_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let resolveReady!: (value: WorkerEvent) => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<WorkerEvent>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveResult!: (value: WorkerEvent) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<WorkerEvent>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const events: WorkerEvent[] = [];
  const stdout = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as WorkerEvent;
        events.push(event);
        if (event.event === "ready") resolveReady(event);
        if (event.event === "result") resolveResult(event);
        if (event.event === "fatal") {
          const failure = new Error(event.message ?? "native-main refresh worker failed");
          rejectReady(failure);
          rejectResult(failure);
        }
      }
    }
    if (pending) {
      const event = JSON.parse(pending) as WorkerEvent;
      events.push(event);
      if (event.event === "ready") resolveReady(event);
      if (event.event === "result") resolveResult(event);
    }
  })();
  child.exited.then(async exit => {
    if (exit === 0) return;
    const failure = new Error(await new Response(child.stderr).text());
    rejectReady(failure);
    rejectResult(failure);
  });
  return { child, ready, result, events, stdout };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-main-flight-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
  }));
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("native-main refresh process coordination", () => {
  test("same-home callers join exactly one refresh flight", async () => {
    let attempts = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const refreshToken = async () => {
      attempts += 1;
      entered();
      await completed;
      return { access: "fresh-access", refresh: "rotated-grant", expires: Date.now() + 3_600_000, accountId: "account-main" };
    };
    const first = getValidMainAccountToken({ refreshToken });
    await started;
    const second = getValidMainAccountToken({ refreshToken });
    finish();

    await expect(first).resolves.toEqual({ accessToken: "fresh-access", chatgptAccountId: "account-main" });
    await expect(second).resolves.toEqual({ accessToken: "fresh-access", chatgptAccountId: "account-main" });
    expect(attempts).toBe(1);
  });

  test("two Bun PIDs share the SQLite claim and persist one rotated credential", async () => {
    const first = spawnRefreshWorker();
    const second = spawnRefreshWorker();
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.write("run\n");
    second.child.stdin.write("run\n");
    first.child.stdin.end();
    second.child.stdin.end();

    const [firstResult, secondResult, firstExit, secondExit] = await Promise.all([
      first.result,
      second.result,
      first.child.exited,
      second.child.exited,
    ]);
    await Promise.all([first.stdout, second.stdout]);

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(new Set([first.events[0]?.pid, second.events[0]?.pid]).size).toBe(2);
    expect([...first.events, ...second.events].filter(event => event.event === "refresh")).toHaveLength(1);
    expect(firstResult).toMatchObject({ event: "result", accessToken: "fresh-access", chatgptAccountId: "account-main" });
    expect(secondResult).toMatchObject({ event: "result", accessToken: "fresh-access", chatgptAccountId: "account-main" });
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-grant",
    });
  });
});
