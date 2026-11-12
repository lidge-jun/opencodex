import { afterEach, describe, expect, test } from "bun:test";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { STANDIN_MAX_MESSAGE_BYTES, startRelayStandin, type RelayStandin } from "../fixtures/link-child-relay-standin";

// Lane T5f: the link WebSocket release gate of design T4 11.1 item 13, with the pinned Codex binary as the client (U13).
// The pinned binary is codex-rs built at openai/codex 88c5856 (design section 0). These tests run only when
// OCX_LINK_GATE_CODEX names it; otherwise each is skipped with that reason. Codex reaches the Home through a test-only
// stand-in for the Child's relay (tests/fixtures/link-child-relay-standin.ts), because the Child's relay is lane T6.
// Codex is an external process with no clock to inject, so each test carries a per-test bound instead of sleeps.

const BIN = process.env.OCX_LINK_GATE_CODEX ?? "";
const usable = (() => { if (!BIN) return false; try { accessSync(BIN, constants.X_OK); return true; } catch { return false; } })();
const SKIP = " [skipped: pinned Codex binary absent (U13); set OCX_LINK_GATE_CODEX to codex-rs built at openai/codex 88c5856]";
const gate = (title: string, body: () => Promise<void>) => test.skipIf(!usable)(title + (usable ? "" : SKIP), body, 180_000);

const KEY_ID = "gate-key"; const SECRET = "gate-secret-0123456789abcdef"; const LINK = "lnk_9a9a9a9a9a9a9a9a";
const identity = { keyId: KEY_ID, linkId: LINK, fingerprint: serviceApiTokenFingerprint(SECRET) };

function completed(id: string): string {
  const message = { type: "message", id: "msg_" + id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "gate-ok", annotations: [] }] };
  return [
    "event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }) + "\n\n",
    "event: response.output_item.done\ndata: " + JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message }) + "\n\n",
    "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) + "\n\n",
  ].join("");
}

const previous = { home: process.env.OPENCODEX_HOME };
let dir = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(force?: boolean): Promise<void> } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let standin: RelayStandin | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await standin?.stop(); standin = null;
  if (server) await server.stop(true);
  server = null;
  if (upstream) await upstream.stop(true);
  upstream = null;
  codexHome?.restore(); codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  if (dir) removeTreeWithRetry(dir);
  dir = "";
});

/** A scratch Home with the link WebSocket on, one client-initiated link, and a fixture upstream answered by `answer`. */
async function home(answer: (body: string, index: number) => Response | Promise<Response>) {
  dir = mkdtempSync(join(tmpdir(), "ocx-link-gate-"));
  process.env.OPENCODEX_HOME = join(dir, "home");
  codexHome = installIsolatedCodexHome("ocx-link-gate-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  let index = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.text(); return answer(body, index++); } });
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "gate", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
  const { saveConfig } = await import("../../src/config");
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
    apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
  setLinkWebsocketTransportReadyForTests(true);
  const start = async () => { const { startServer } = await import("../../src/server"); server = startServer(0); };
  await start();
  const linkPort = () => JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  return { start, linkPort };
}

/** Runs one `codex exec` turn against the stand-in, with a scratch HOME and CODEX_HOME and nothing else from this machine. */
function runCodex(port: number, prompt: { argument: string } | { stdin: string }, options: { instructionsBytes?: number } = {}) {
  const scratch = mkdtempSync(join(dir, "codex-"));
  const codexDir = join(scratch, "codex-home");
  mkdirSync(codexDir, { recursive: true });
  // Codex caps a prompt at 1 MiB of characters; its base instructions have no such cap, so a large request comes from them.
  const instructions = options.instructionsBytes ? join(scratch, "instructions.md") : null;
  if (instructions) writeFileSync(instructions, "Answer with gate-ok.\n" + "x".repeat(options.instructionsBytes!));
  writeFileSync(join(codexDir, "config.toml"), [
    ...(instructions ? ["model_instructions_file = " + JSON.stringify(instructions)] : []),
    'model = "fixture/fixture"', 'model_provider = "ocxgate"', "model_context_window = 100000000",
    'approval_policy = "never"', 'sandbox_mode = "read-only"', "",
    "[model_providers.ocxgate]", 'name = "ocx gate"', 'base_url = "http://127.0.0.1:' + port + '/v1"', 'env_key = "OCX_GATE_KEY"',
    'wire_api = "responses"', "supports_websockets = true", "stream_max_retries = 3", "request_max_retries = 1", "",
  ].join("\n"));
  const args = [BIN, "exec", "--skip-git-repo-check", "-C", scratch, "argument" in prompt ? prompt.argument : "-"];
  const child = Bun.spawn(args, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, CODEX_HOME: codexDir, OCX_GATE_KEY: "gate-client-key" },
    stdin: "stdin" in prompt ? new TextEncoder().encode(prompt.stdin) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const done = (async () => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }))();
  return done;
}

/** Codex's own account of a failure is part of the evidence: a non-zero exit fails with the tail of its stderr. */
function expectCompleted(result: { code: number; stdout: string; stderr: string }): void {
  if (result.code !== 0) throw new Error("codex exited " + result.code + ": " + result.stderr.slice(-1500));
  expect(result.stdout).toContain("gate-ok");
}

describe("link WebSocket release gate (design 11.1 item 13)", () => {
  gate("drain: the switch goes off after the upgrade, the socket drains, and the turn ends on HTTP", async () => {
    const h = await home((_body, index) => new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }));
    let turnedOff = false;
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET, onUpgrade: () => {
      // The Home's switch goes off while this socket is open: the Home drains it and later upgrades are refused.
      if (!turnedOff) { turnedOff = true; setLinkWebsocketTransportReadyForTests(false); }
    } });
    const result = await runCodex(standin.port, { argument: "say gate-ok" });
    expectCompleted(result);
    expect(standin.events[0]).toBe("upgrade");
    expect(standin.events.some(event => event.startsWith("upgrade-refused:"))).toBe(true);
    expect(standin.events.at(-1)).toBe("http:200");
  });

  gate("a request over the 8 MiB message limit goes over HTTP", async () => {
    const sizes: number[] = [];
    const h = await home((body, index) => { sizes.push(body.length); return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }); });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    const result = await runCodex(standin.port, { argument: "say gate-ok" }, { instructionsBytes: STANDIN_MAX_MESSAGE_BYTES + 1024 });
    expectCompleted(result);
    expect(standin.events).toContain("http:200");
    expect(Math.max(...sizes)).toBeGreaterThan(STANDIN_MAX_MESSAGE_BYTES);
  });

  gate("a Home restart mid-turn: the turn completes after Codex reconnects", async () => {
    let firstSeen!: () => void;
    const first = new Promise<void>(resolve => { firstSeen = resolve; });
    const h = await home((_body, index) => {
      if (index === 0) {
        firstSeen();
        // The first request starts and never finishes: the Home restarts under it.
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: { id: "resp_cut", status: "in_progress", output: [] } }) + "\n\n"));
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } });
    });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    const result = runCodex(standin.port, { argument: "say gate-ok" });
    await first;
    await server!.stop(true);
    await h.start();
    const done = await result;
    expectCompleted(done);
    // The cut turn ran on the link WebSocket; what Codex used after the restart is its own retry policy (C4, C5).
    expect(standin.events[0]).toBe("upgrade");
    expect(standin.events.length).toBeGreaterThan(1);
  });

  test.skip("a 503 sequence while the Child's tunnel reconnects, recovering on WebSocket and, separately, ending on HTTP [skipped: the Child's tunnel and 503 sequence are lane T6]", () => {});
});
