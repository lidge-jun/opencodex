import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_MCP_SERVER_NAME,
  advisorHookCommand,
  buildNoticeHookScript,
  mountAdvisorMcpForClient,
  shellQuote,
  unmountAdvisorMcpForClient,
} from "../../src/advisor/client-mcp";
import { consultAdvisor } from "../../src/advisor/consult";
import { runExternalAdvisorConsult } from "../../src/advisor/external-consult";
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
});

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
  const first = await runExternalAdvisorConsult(config, { consultationId: ids[0], waitMs: 0 }, { consultFn });
  expect(first.status).toBe(200);
});
