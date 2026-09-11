import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { distribution, summarizeAstraEffortCache } from "./astra-effort-cache-report";

const [mode, ...args] = process.argv.slice(2);
const user = (content: string) => ({ role: "user", content });
const body = (input: unknown[], effort = "medium") => ({ model: "gpt-6-astra", instructions: "Synthetic fixture", input, reasoning: { effort }, store: false, stream: true });

if (mode === "--worker") {
  const [home, worker, countArg, bytesArg] = args;
  process.env.OPENCODEX_HOME = join(home, "config");
  const { applyAstraEffortCache } = await import("../src/adapters/astra-effort-cache");
  const count = Number(countArg);
  const first = [user("x".repeat(Number(bytesArg)))];
  const second = [...first, { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }, user("next")];
  if (worker === "0") {
    const { recordOwnedConfigPath } = await import("../src/lib/config-ownership");
    if (!recordOwnedConfigPath(process.env.OPENCODEX_HOME!, join(process.env.OPENCODEX_HOME!, "astra-effort-cache"))) throw new Error("Cannot own synthetic cache directory");
  }
  writeFileSync(join(home, `ready-${worker}`), "");
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(home, "go"))) {
    if (Date.now() > deadline) throw new Error("Synthetic worker barrier timeout");
    await Bun.sleep(5);
  }
  const samples = [];
  for (let i = 0; i < count; i++) {
    const scenario = i % 4;
    const request = body(scenario === 0 ? first : second, scenario === 0 ? "medium" : "low");
    const headers = new Headers({ "thread-id": `worker-${worker}-conversation-${Math.floor(i / 4)}` });
    const started = performance.now();
    const result = applyAstraEffortCache(request, request, headers, new Headers({ "chatgpt-account-id": "synthetic-account" }));
    samples.push({ worker: Number(worker), scenario: ["new-conversation", "switch", "replay", "replay"][scenario], wallMs: performance.now() - started, ...result.metrics });
  }
  console.log(JSON.stringify(samples));
} else if (mode === "--proxy") {
  const [native, countArg, concurrencyArg, bytesArg, runtimeRoot] = args;
  const { startAstraEffortProxy } = await import("../tests/helpers/astra-effort-proxy");
  const { readRecentUsageEntries } = await import("../src/usage/log");
  const fixture = await startAstraEffortProxy(native === "true", runtimeRoot);
  const samples: Array<{ transport: string; wallMs: number }> = [];
  const count = Number(countArg);
  const concurrency = Number(concurrencyArg);
  const started = performance.now();
  let maxTimerDelayMs = 0;
  let tick = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxTimerDelayMs = Math.max(maxTimerDelayMs, now - tick - 5); tick = now; }, 5);
  try {
    for (const transport of ["http", "websocket"]) {
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        const thread = `${transport}-${worker}`;
        const ws = transport === "websocket" ? fixture.websocket(thread) : undefined;
        let input: unknown[] = [];
        try {
          for (let i = 0; i < count; i++) {
            input.push(user(i === 0 ? "x".repeat(Number(bytesArg)) : "next"));
            const request = body(input, i % 2 ? "low" : "medium");
            const start = performance.now();
            const response = ws ? await ws.turn(request) : await fixture.http(request, thread);
            samples.push({ transport, wallMs: performance.now() - start });
            input = [...input, ...response.output];
          }
        } finally { ws?.close(); }
      }));
    }
    await Bun.sleep(10);
    const elapsedMs = performance.now() - started;
    const measurements = summarizeAstraEffortCache(readRecentUsageEntries(10_000, fixture.home));
    const observedUpstreamTransports = [...new Set(fixture.captured.map(row => row.transport))].sort();
    console.log(JSON.stringify({ samples, elapsedMs, requestsPerSecond: samples.length / elapsedMs * 1000, maxTimerDelayMs, observedUpstreamTransports, measurements }));
  } finally { clearInterval(timer); await fixture.stop(); }
} else {
  const outDir = mode;
  const [countArg = "40", concurrencyArg = "4", controlRoot] = args;
  const count = Number(countArg), concurrency = Number(concurrencyArg);
  if (!outDir || !Number.isSafeInteger(count) || count < 4 || count > 200 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Usage: bun scripts/astra-effort-cache-eval.ts <outDir> [4..200 turns] [1..16 workers] [control worktree]");
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), "astra-eval-"));
  mkdirSync(join(scratch, "codex"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const root = resolve(import.meta.dir, "..");
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, OPENCODEX_HOME: scratch, CODEX_HOME: join(scratch, "codex") };
  for (const key of Object.keys(env)) if (/^(http|https|all)_proxy$/i.test(key)) delete (env as Record<string, string | undefined>)[key];
  function spawn(childArgs: string[]) {
    const child = Bun.spawn([process.execPath, import.meta.path, ...childArgs], { env, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    return child;
  }
  async function result(child: ReturnType<typeof spawn>) {
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Synthetic benchmark child failed (${code}): ${error.slice(-1000)}`);
    const json = text.trim().split("\n").at(-1)!;
    return JSON.parse(json);
  }
  function revision(path: string) {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path });
    const diff = Bun.spawnSync(["git", "diff", "HEAD"], { cwd: path });
    const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ":!node_modules"], { cwd: path });
    if (head.exitCode || diff.exitCode || untracked.exitCode) throw new Error("Cannot identify benchmark checkout");
    const hash = createHash("sha256").update(diff.stdout);
    const files = untracked.stdout.toString().split("\0").filter(Boolean).sort();
    for (const file of files) hash.update(file).update(readFileSync(join(path, file)));
    return { commit: head.stdout.toString().trim(), dirty: diff.stdout.length > 0 || files.length > 0, patchSha256: hash.digest("hex") };
  }
  const cells = [];
  try {
    for (const bytes of [1024, 64 * 1024, 1024 * 1024]) {
      for (const workers of [...new Set([1, concurrency])]) {
        const home = join(scratch, `direct-${bytes}-${workers}`); mkdirSync(home);
        const tasks = Array.from({ length: workers }, (_, i) => spawn(["--worker", home, String(i), String(count), String(bytes)]));
        const deadline = Date.now() + 15_000;
        while (!tasks.every((_, i) => existsSync(join(home, `ready-${i}`)))) {
          for (const task of tasks) if (task.exitCode !== null) await result(task);
          if (Date.now() > deadline) throw new Error("Synthetic workers failed to reach barrier");
          await Bun.sleep(5);
        }
        writeFileSync(join(home, "go"), "");
        const samples = (await Promise.all(tasks.map(result))).flat();
        cells.push({ kind: "synchronous-hook", inputTextBytes: bytes, workers, samples, wallMs: distribution(samples.map(row => row.wallMs)), statuses: samples.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {} as Record<string, number>) });
      }
    }
    for (const native of [false, true]) {
      for (const [arm, runtime] of [["treatment", undefined], ...(controlRoot ? [["control", resolve(controlRoot)]] : [])] as const) {
        cells.push({ kind: "proxy", arm, upstreamWebSocketAvailable: native, inputTextBytes: 64 * 1024, workers: concurrency,
          ...await result(spawn(["--proxy", String(native), String(count), String(concurrency), String(64 * 1024), ...(runtime ? [runtime] : [])])) });
      }
    }
    const report = { schemaVersion: 1, synthetic: true, platform: process.platform, arch: process.arch, bun: Bun.version, bunVersionWithSha: Bun.version_with_sha, treatment: revision(root), ...(controlRoot ? { control: revision(resolve(controlRoot)) } : {}), cells };
    writeFileSync(join(outDir, "samples.jsonl"), cells.flatMap((cell, i) => cell.samples.map((sample: unknown) => JSON.stringify({ cell: i, sample }))).join("\n") + "\n");
    writeFileSync(join(outDir, "report.json"), JSON.stringify({ ...report, cells: cells.map(({ samples, ...cell }) => ({ ...cell, sampleCount: samples.length, ...(cell.kind === "proxy" ? { wallMs: distribution(samples.map((row: any) => row.wallMs)) } : {}) })) }, null, 2) + "\n");
    console.log("Synthetic benchmark complete: report.json and samples.jsonl");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(scratch, { recursive: true, force: true });
  }
}
