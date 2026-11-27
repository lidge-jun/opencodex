import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_MCP_SERVER_NAME,
  advisorHookCommand,
  buildNoticeHookScript,
  mountAdvisorMcpForClient,
  shellQuote,
  syncAdvisorMcpClients,
  unmountAdvisorMcpForClient,
} from "../../src/advisor/client-mcp";
import { consultAdvisor } from "../../src/advisor/consult";
import { callAdvisorConsultApi } from "../../src/advisor/mcp-server";
import { loadWorkBuddySessionMessages, runExternalAdvisorConsult } from "../../src/advisor/external-consult";
import { resolveAdvisorSettings } from "../../src/advisor/settings";
import type { OcxConfig } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTreeWithRetry(home); });
function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

describe("Advisor client MCP safety", () => {
  test("transcript reading remains bounded when a file grows after discovery", async () => {
    const { readBoundedTranscriptFile } = await import("../../src/advisor/transcript-read");
    const home = tempHome("ocx-advisor-transcript-bound-");
    const path = join(home, "session.jsonl");
    writeFileSync(path, "small");
    expect(statSync(path).size).toBeLessThan(4 * 1024 * 1024);
    expect(readBoundedTranscriptFile(path)).toBe("small");
    appendFileSync(path, Buffer.alloc(4 * 1024 * 1024));
    expect(readBoundedTranscriptFile(path)).toBeUndefined();
  });
  test("MCP call bounds a stalled local HTTP response body", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await Promise.race([
      callAdvisorConsultApi({ consultationId: "existing" }, { baseUrl: "http://proxy.test", fetchImpl, waitMs: 0 }),
      Bun.sleep(1500).then(() => null),
    ]);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("timed out");
  });
  test("MCP call bounds a stalled fetch and preserves caller cancellation", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("cancelled"));
        else init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })) as typeof fetch;
    const result = await callAdvisorConsultApi({ question: "test" }, { baseUrl: "http://proxy.test", fetchImpl, waitMs: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
    const caller = new AbortController();
    caller.abort();
    const cancelled = await callAdvisorConsultApi({ question: "test" }, { baseUrl: "http://proxy.test", fetchImpl, waitMs: 0 }, caller.signal);
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content[0]?.text).not.toContain("timed out");
  });
  test("transcript selection prefers the session over a newer task fallback and filters direct advisor calls", () => {
    const root = tempHome("ocx-advisor-transcript-priority-");
    writeFileSync(join(root, "session.jsonl"), [
      JSON.stringify({ type: "message", message: { role: "user", content: "session content" } }),
      JSON.stringify({ type: "function_call", name: "consult_advisor", callId: "old", arguments: '{"question":"ordinary question"}' }),
      JSON.stringify({ type: "function_call_result", callId: "old", output: "old advice" }),
    ].join("\n"));
    writeFileSync(join(root, "task.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: "wrong task content" } }));
    utimesSync(join(root, "session.jsonl"), new Date(1_000), new Date(1_000));
    const result = loadWorkBuddySessionMessages({ sessionId: "session", taskId: "task", workbuddyProjectsDir: root, nowMs: Date.now() });
    const content = JSON.stringify(result.messages);
    expect(content).toContain("session content");
    expect(content).not.toContain("wrong task content");
    expect(content).not.toContain("ordinary question");
    expect(content).not.toContain("old advice");
  });
  test("an explicit homeDir never follows the host's client config-directory override", () => {
    const home = tempHome("ocx-advisor-env-");
    const outside = tempHome("ocx-advisor-outside-");
    const saved = process.env.QODER_CONFIG_DIR;
    process.env.QODER_CONFIG_DIR = outside;
    try {
      expect(mountAdvisorMcpForClient("qoder", { homeDir: home, configDir: join(home, ".opencodex") }).ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.QODER_CONFIG_DIR; else process.env.QODER_CONFIG_DIR = saved;
    }
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".qoder", "settings.json"))).toBe(true);
  });

  test("hook paths stay literal in the script and in the registered command", () => {
    const root = tempHome("ocx-advisor-quote-");
    const marker = join(root, "substituted");
    const backtick = String.fromCharCode(96);
    const hostile = join(root, "a b $(touch " + marker + ") " + backtick + "touch " + marker + backtick + " it's");
    const script = buildNoticeHookScript(hostile, join(hostile, "bun"));
    const assignments = script.split("\n").filter(line => line.startsWith("BUN_BIN=") || line.startsWith("CFG_PATH="));
    expect(assignments).toHaveLength(2);
    const run = spawnSync("sh", ["-c", assignments.join("\n") + "\nprintf '%s\\n%s' \"$BUN_BIN\" \"$CFG_PATH\""], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(join(hostile, "bun") + "\n" + join(hostile, "config.json"));
    expect(existsSync(marker)).toBe(false);

    const home = tempHome("ocx advisor home ");
    expect(mountAdvisorMcpForClient("qoder", { homeDir: home, configDir: join(home, ".opencodex"), env: {} }).ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".qoder", "settings.json"), "utf8")) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> } };
    const scriptPath = join(home, ".qoder", "hooks", "opencodex-advisor-notice.sh");
    expect(settings.hooks.UserPromptSubmit.at(-1)!.hooks[0]!.command).toBe(advisorHookCommand(scriptPath));
    expect(advisorHookCommand(scriptPath)).toBe(shellQuote(scriptPath));
  });

  test("hook stays quiet when its settings or runtime are unavailable", () => {
    const home = tempHome("ocx-advisor-hook-ready-");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USERPROFILE: home };
    const run = (execPath: string) => spawnSync("sh", ["-c", buildNoticeHookScript(home, execPath)], { encoding: "utf8", env, input: "{}" });
    expect(run(process.execPath).stdout).toBe("");
    writeFileSync(join(home, "config.json"), JSON.stringify({ advisor: { enabled: true, model: "expert", contextSharingConsent: "v1" } }));
    expect(run(join(home, "missing-bun")).stdout).toBe("");
    expect(run(process.execPath).stdout).toContain("active and ready");
  });

  test("automatic MCP mounting is off unless the operator turns it on", () => {
    const config = { advisor: { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1" } } as Pick<OcxConfig, "advisor">;
    expect(resolveAdvisorSettings(config).autoMountMcp).toBe(false);
  });

  test("a user-created opencodex-advisor MCP entry is neither replaced nor removed", () => {
    const home = tempHome("ocx-advisor-owner-");
    const configDir = join(home, ".opencodex");
    const settingsPath = join(home, ".qoder", "settings.json");
    mkdirSync(join(home, ".qoder"), { recursive: true });
    const userText = JSON.stringify({ mcpServers: { [ADVISOR_MCP_SERVER_NAME]: { command: "/opt/my-own-advisor" } } }, null, 2) + "\n";
    writeFileSync(settingsPath, userText);
    const refused = mountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {} });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("OpenCodex did not write it");
    expect(readFileSync(settingsPath, "utf8")).toBe(userText);
    unmountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {} });
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers[ADVISOR_MCP_SERVER_NAME]).toEqual({ command: "/opt/my-own-advisor" });

    // An entry OpenCodex wrote is replaced and removed as before, including after its launch command changes.
    writeFileSync(settingsPath, "{}\n");
    expect(mountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {}, execPath: "/old/bun" }).ok).toBe(true);
    expect(mountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {}, execPath: "/new/bun" }).ok).toBe(true);
    expect(unmountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {}, execPath: "/new/bun" }).changed).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers?.[ADVISOR_MCP_SERVER_NAME]).toBeUndefined();
  });
  test("clients sharing one config entry retain ownership when selection changes", () => {
    const home = tempHome("ocx-advisor-shared-slot-");
    const configDir = join(home, ".opencodex");
    const shared = join(home, "shared");
    const opts = { homeDir: home, configDir, env: { WORKBUDDY_CONFIG_DIR: shared }, execPath: "/old/bun" };
    expect(mountAdvisorMcpForClient("workbuddy", opts).ok).toBe(true);
    expect(mountAdvisorMcpForClient("workbuddy-ai", opts).ok).toBe(true);
    expect(mountAdvisorMcpForClient("workbuddy-ai", { ...opts, execPath: "/new/bun" }).ok).toBe(true);
    expect(readFileSync(join(shared, "mcp.json"), "utf8")).toContain("/new/bun");
    expect(unmountAdvisorMcpForClient("workbuddy-ai", { ...opts, execPath: "/new/bun" }).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(shared, "mcp.json"), "utf8")).mcpServers[ADVISOR_MCP_SERVER_NAME]).toBeUndefined();
  });
  test("switching clients preserves a shared config reached through a directory symlink", () => {
    const home = tempHome("ocx-advisor-path-alias-");
    const configDir = join(home, ".opencodex");
    const realDir = join(home, "qoder-real");
    const alias = join(home, "qoder-alias");
    mkdirSync(realDir);
    symlinkSync(realDir, alias, "dir");
    const opts = { homeDir: home, configDir, env: { QODER_CONFIG_DIR: realDir, QODERCN_CONFIG_DIR: alias }, execPath: "/same/bun" };
    expect(mountAdvisorMcpForClient("qoder", opts).ok).toBe(true);
    const config = { advisor: { enabled: true, model: "expert/m", contextSharingConsent: "v1", mcpClients: ["qoder-cn"] } } as Pick<OcxConfig, "advisor">;
    expect(syncAdvisorMcpClients(config, opts).errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(realDir, "settings.json"), "utf8")).mcpServers[ADVISOR_MCP_SERVER_NAME]).toBeDefined();
  });
  test("an identical opencodex-advisor entry OpenCodex never recorded is used but never deleted", () => {
    const home = tempHome("ocx-advisor-identical-");
    const configDir = join(home, ".opencodex");
    const settingsPath = join(home, ".qoder", "settings.json");
    // Learn the exact bytes OpenCodex writes from a separate home, then plant them unrecorded.
    const probe = tempHome("ocx-advisor-probe-");
    expect(mountAdvisorMcpForClient("qoder", { homeDir: probe, configDir, env: {}, execPath: "/same/bun" }).ok).toBe(true);
    removeTreeWithRetry(join(configDir, "advisor-mcp-entries.json"));
    const entry = JSON.parse(readFileSync(join(probe, ".qoder", "settings.json"), "utf8")).mcpServers[ADVISOR_MCP_SERVER_NAME];
    mkdirSync(join(home, ".qoder"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ mcpServers: { [ADVISOR_MCP_SERVER_NAME]: entry } }, null, 2) + "\n");
    expect(mountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {}, execPath: "/same/bun" }).ok).toBe(true);
    expect(existsSync(join(configDir, "advisor-mcp-entries.json"))
      && JSON.parse(readFileSync(join(configDir, "advisor-mcp-entries.json"), "utf8")).qoder).toBeFalsy();
    unmountAdvisorMcpForClient("qoder", { homeDir: home, configDir, env: {}, execPath: "/same/bun" });
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).mcpServers[ADVISOR_MCP_SERVER_NAME]).toEqual(entry);
  });});

describe("Advisor stream completion", () => {
  const input = { parsed: parseRequest({ model: "worker", input: [{ role: "user", content: "Fix it" }] }), workerIdentity: "worker", advisorModel: "expert", reason: "manual" as const };
  async function consultWith(events: string[]) {
    const body = events.map(event => "data: " + event + "\n\n").join("");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    try { return await consultAdvisor(input, {}, "medium", 5_000, undefined, "http://127.0.0.1:" + server.port); } finally { server.stop(true); }
  }
  const delta = (text: string, finish: string | null = null) => JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] });

  test("a stream that ends without a terminal signal is not finished advice", async () => {
    expect(await consultWith([delta("Half of the ")])).toMatchObject({ ok: false, error: "advisor stream ended before completion" });
  });
  test("a malformed event inside a stream fails the consultation", async () => {
    expect(await consultWith([delta("Check "), "{not json", delta("the lock", "stop"), "[DONE]"])).toMatchObject({ ok: false, error: "advisor returned non-JSON" });
  });
  test("a finish_reason or [DONE] completes the stream", async () => {
    expect(await consultWith([delta("Check the lock.", "stop")])).toMatchObject({ ok: true, advice: "Check the lock." });
    expect(await consultWith([delta("Check the lock."), "[DONE]"])).toMatchObject({ ok: true, advice: "Check the lock." });
  });
});

test("completed consultations stay pollable for their retention; a full store reports its capacity", async () => {
  const config = { port: 10100, providers: {}, advisor: { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1" } } as unknown as OcxConfig;
  const consultFn = async () => ({ ok: true, advice: "done", advisorModel: "expert/gpt-6-astra", durationMs: 1 });
  const ids: string[] = [];
  for (let index = 0; index < 32; index++) {
    const started = await runExternalAdvisorConsult(config, { question: "question " + index, waitMs: 240_000 }, { consultFn });
    expect(started.status).toBe(200);
    ids.push(String(started.body.consultationId));
  }
  const full = await runExternalAdvisorConsult(config, { question: "one more", waitMs: 240_000 }, { consultFn });
  expect(full.status).toBe(429);
  expect((full.body.error as { code: string }).code).toBe("advisor_capacity_exceeded");
  const message = (full.body.error as { message: string }).message;
  expect(message).toContain("retained consultations");
  expect(message).toContain("earliest expiry");
  expect(message).not.toContain("active consultation completes");
  const first = await runExternalAdvisorConsult(config, { consultationId: ids[0], waitMs: 0 }, { consultFn });
  expect(first.status).toBe(200);
});
