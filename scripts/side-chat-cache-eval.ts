import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distribution, summarizeSideChatCache } from "./side-chat-cache-report";

const [mode, ...args] = process.argv.slice(2);
if (mode === "--cell") {
  const [enabledArg, nativeArg, turnsArg, concurrencyArg, bytesArg] = args;
  const [{ startCacheProxy }, { SIDE_CHAT_BOUNDARY }, { readRecentUsageEntries }] = await Promise.all([
    import("../tests/helpers/side-chat-cache-proxy"), import("../src/codex/side-chat-cache"), import("../src/usage/log")]);
  const fixture = await startCacheProxy(nativeArg === "true", enabledArg === "true");
  const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
  const history = [message("developer", "Synthetic rules"), message("user", "x".repeat(Number(bytesArg)))];
  const body = (thread: string, input: unknown[], parent?: string) => ({ model: "gpt-5.6-luna", instructions: "Synthetic", input, stream: true, store: false,
    prompt_cache_key: thread, client_metadata: { thread_id: thread, session_id: thread, ...(parent ? { forked_from_thread_id: parent } : {}) } });
  const samples: Array<{ transport: string; phase: string; wallMs: number }> = [];
  try {
    const parent = await fixture.http(body("parent", history), "parent");
    for (const transport of ["http", "websocket"]) {
      await Promise.all(Array.from({ length: Number(concurrencyArg) }, async (_, i) => {
        const thread = `${transport}-${i}`;
        const ws = transport === "websocket" ? fixture.websocket(thread, "parent") : undefined;
        let input = [...history, ...parent.output, message("user", SIDE_CHAT_BOUNDARY), message("user", "Side question")];
        try {
          for (let turn = 0; turn < Number(turnsArg); turn++) {
            const request = body(thread, input, "parent");
            const started = performance.now();
            const response = ws ? await ws.turn(request) : await fixture.http(request, thread, false, "parent");
            samples.push({ transport, phase: turn ? "follow-up" : "first-observed-side", wallMs: performance.now() - started });
            input = [...input, ...response.output, message("user", "Next")];
          }
        } finally { ws?.close(); }
      }));
    }
    console.log(JSON.stringify({ samples, observedUpstreamTransports: [...new Set(fixture.captured.map(row => row.transport))].sort(),
      measurements: summarizeSideChatCache(readRecentUsageEntries(10_000, fixture.home)) }));
  } finally { await fixture.stop(); }
} else {
  const [turnsArg = "20", concurrencyArg = "4"] = args;
  const turns = Number(turnsArg), concurrency = Number(concurrencyArg);
  if (!mode || !Number.isSafeInteger(turns) || turns < 2 || turns > 200 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Usage: bun scripts/side-chat-cache-eval.ts <outDir> [2..200 turns] [1..16 clients]");
  }
  mkdirSync(mode, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(tmpdir(), "side-eval-"));
  mkdirSync(join(home, "codex"));
  const cells = [];
  const direct = [];
  try {
    const { SideChatCache, SIDE_CHAT_BOUNDARY } = await import("../src/codex/side-chat-cache");
    for (const [items, tools] of [[4, 16], [128, 128], [1024, 256]]) {
      const cache = new SideChatCache();
      const catalog = { type: "additional_tools", role: "developer", tools: Array.from({ length: tools }, (_, i) => ({ type: "function", name: `tool_${i}`, description: "Synthetic contract", parameters: { type: "object", properties: {} } })) };
      const history = Array.from({ length: items }, (_, i) => ({ role: i ? "user" : "developer", content: `Synthetic item ${i}` }));
      const headers = (thread: string) => ({ authorization: "Bearer synthetic", "chatgpt-account-id": "synthetic-account", "thread-id": thread, "session-id": thread });
      const base = { model: "gpt-5.6-luna", instructions: "Synthetic", stream: true, store: false, prompt_cache_key: "parent", input: [catalog, ...history] };
      cache.prepare(base, headers("parent")).complete();
      const samples = [];
      for (let i = 0; i < turns; i++) {
        const request = { ...base, prompt_cache_key: "child", client_metadata: { forked_from_thread_id: "parent" },
          input: [{ ...catalog, tools: [...catalog.tools].reverse() }, ...history, { role: "user", content: SIDE_CHAT_BOUNDARY }, { role: "user", content: "Side question" }] };
        const decision = cache.prepare(request, headers("child"));
        decision.complete();
        const { threadIdHash: _thread, ...sample } = decision.metrics;
        samples.push(sample);
      }
      direct.push({ inputItems: items, catalogTools: tools, samples });
    }
    for (const bytes of [1024, 64 * 1024, 1024 * 1024]) {
      for (const native of [false, true]) {
        for (const enabled of [false, true]) {
          const child = Bun.spawn([process.execPath, import.meta.path, "--cell", String(enabled), String(native), String(turns), String(concurrency), String(bytes)],
            { env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: home, CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
          const timeout = setTimeout(() => child.kill(), 120_000);
          try {
            const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            if (code !== 0) throw new Error(`Synthetic side-cache cell failed (${code}): ${stderr.slice(-1000)}`);
            const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
            cells.push({ enabled, upstreamWebSocketAvailable: native, inputTextBytes: bytes, clients: concurrency, ...result });
          } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
        }
      }
    }
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "..") });
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: join(import.meta.dir, "..") });
    if (head.exitCode || status.exitCode) throw new Error("Cannot identify benchmark checkout");
    writeFileSync(join(mode, "samples.jsonl"), [...cells.flatMap((cell, index) => cell.samples.map((sample: unknown) => JSON.stringify({ cell: index, sample }))), ...direct.flatMap((cell, index) => cell.samples.map(sample => JSON.stringify({ direct: index, sample })))].join("\n") + "\n");
    writeFileSync(join(mode, "report.json"), JSON.stringify({ schemaVersion: 1, synthetic: true, platform: process.platform, arch: process.arch,
      bunVersionWithSha: Bun.version_with_sha, commit: head.stdout.toString().trim(), dirty: status.stdout.length > 0,
      direct: direct.map(({ samples, ...cell }) => ({ ...cell, prepareMs: distribution(samples.map(row => row.prepareMs)), last: samples.at(-1) })),
      cells: cells.map(({ samples, ...cell }) => ({ ...cell, wallMs: distribution(samples.map((row: { wallMs: number }) => row.wallMs)) })) }, null, 2) + "\n");
    console.log("Synthetic benchmark complete: report.json and samples.jsonl");
  } finally { rmSync(home, { recursive: true, force: true }); }
}
