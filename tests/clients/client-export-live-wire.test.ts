/**
 * Live-wire regression harness for the OpenCode and Kilo client config exports.
 *
 * These tests spawn REAL client binaries (@opencode/cli, @kilocode/cli) against
 * a scripted local OpenAI-compatible upstream and assert what each client
 * actually puts on the wire for the documents our export produces. No remote
 * model is contacted, no credential beyond a dummy loopback token exists, and
 * every client process gets an isolated HOME/XDG tree under a scratch root.
 *
 * Opt-in — the suite skips unless the binaries are provided:
 *
 *   export OCX_TEST_OPENCODE_BIN=/path/to/opencode   # verified against 2.0.21
 *   export OCX_TEST_KILO_BIN=/path/to/kilo           # verified against 7.8.3
 *   # optional, defaults to <tmp>/ocx-live-wire:
 *   export OCX_TEST_LIVE_SCRATCH=/path/to/scratch
 *
 * Verified live on 2026-10-01 (see the header comment on the helper for the
 * client-side contract rules this encodes):
 *   - @opencode/cli 2.0.21: V2 `providers` block with per-model `variants`
 *     (including `none`) selects and lowers `settings.reasoningEffort` to
 *     `reasoning_effort`; undeclared variants fail resolution; one invalid V2
 *     model entry discards the whole V2 block.
 *   - @kilocode/cli 7.8.3: V1 `provider` block; variant map values carry the
 *     camel `reasoningEffort` option; an all-disabled variant map is the only
 *     working synthesis kill-switch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientConfig } from "../../src/clients/config-export";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { drainAndShutdown } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import {
  ALPHA,
  BRAVO,
  DELTA,
  KILO_SUPPRESS_VARIANTS,
  LIVE_WIRE_KEY_VALUE,
  type CapturedChatRequest,
  type ClientHarness,
  type LiveWireUpstream,
  assistantReasoningReplay,
  buildIntendedKiloDocument,
  buildIntendedOpenCodeDocument,
  findToolMessages,
  hasImagePart,
  kiloHarness,
  lastRealTurn,
  liveWireExportModels,
  openCodeHarness,
  reasoningEffortOf,
  resolveOptInBin,
  rolesOf,
  sanitizeEvidence,
  startLiveWireUpstream,
  spawnClient,
  collectClientRun,
} from "../helpers/client-export-live-wire";

const OC_BIN = resolveOptInBin(process.env.OCX_TEST_OPENCODE_BIN);
const KILO_BIN = resolveOptInBin(process.env.OCX_TEST_KILO_BIN);
const UPSTREAM_TIMEOUT = 240_000;

/** Requests captured since a mark. */
function since(upstream: LiveWireUpstream, mark: number): CapturedChatRequest[] {
  return upstream.requests.slice(mark);
}

describe("live-wire harness subprocess outcomes", () => {
  test("captures success without inventing a timeout", async () => {
    const run = await spawnClient(process.execPath, ["--eval", 'console.log("harness-ok")'], {}, process.cwd(), 5_000);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("harness-ok");
    expect(run.timedOut).toBe(false);
  });

  test("preserves a child failure and its diagnostic", async () => {
    const run = await spawnClient(process.execPath, ["--eval", 'console.error("harness-failure");process.exit(3)'], {}, process.cwd(), 5_000);
    expect(run.code).toBe(3);
    expect(run.stderr.trim()).toBe("harness-failure");
    expect(run.timedOut).toBe(false);
  });

  test("terminates a child that exceeds its budget and cannot report success", async () => {
    const run = await spawnClient(process.execPath, ["--eval", 'setInterval(() => {}, 1000)'], {}, process.cwd(), 100);
    expect(run.timedOut).toBe(true);
    expect(run.code).not.toBe(0);
  });

  test("kill failure cannot hang output or exit collection", async () => {
    const run = await collectClientRun({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: new Promise(() => undefined),
      kill() { throw new Error("synthetic kill failure"); },
    }, 10, 10);
    expect(run.timedOut).toBe(true);
    expect(run.code).toBe(-1);
    expect(run.stderr).toContain("Client termination failed.");
  });

  test("a successful kill cannot hang on inherited open pipes", async () => {
    let kills = 0;
    const run = await collectClientRun({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(0),
      kill() { kills++; },
    }, 10, 10);
    expect(kills).toBe(1);
    expect(run.code).toBe(-1);
    expect(run.timedOut).toBe(true);
    expect(run.stderr).toContain("deadline exceeded");
  });

  test("output failure clears the original timeout instead of killing again later", async () => {
    let kills = 0;
    const run = await collectClientRun({
      stdout: new ReadableStream({ start(controller) { controller.error(new Error("synthetic output failure")); } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(0),
      kill() { kills++; },
    }, 10, 10);
    expect(run.code).toBe(-1);
    expect(run.timedOut).toBe(false);
    expect(run.stderr).toContain("Client output collection failed.");
    await Bun.sleep(30);
    expect(kills).toBe(1);
  });
});

// ===========================================================================
// OpenCode (@opencode/cli)
// ===========================================================================

describe.skipIf(!OC_BIN)("opencode export live wire (opt-in: OCX_TEST_OPENCODE_BIN)", () => {
  let upstream: LiveWireUpstream;
  let client: ClientHarness;

  beforeAll(() => {
    upstream = startLiveWireUpstream();
    client = openCodeHarness(OC_BIN!, "main");
    client.writeGlobalConfig(buildClientConfig("opencode", { baseUrl: upstream.url, models: liveWireExportModels() }));
  });

  afterAll(() => {
    client.cleanup();
    upstream.stop();
  });

  test("generated document matches the intended live-wire shape", () => {
    const generated = buildClientConfig("opencode", { baseUrl: upstream.url, models: liveWireExportModels() });
    expect(generated).toEqual(buildIntendedOpenCodeDocument(upstream.url));
  }, 30_000);

  test("default selection sends the declared default effort", async () => {
    const mark = upstream.requests.length;
    const run = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}`, "hi"]);
    const turn = lastRealTurn(since(upstream, mark));
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBe("low");
    expect(turn?.headers.authorization).toBe(`Bearer ${LIVE_WIRE_KEY_VALUE}`);
  }, UPSTREAM_TIMEOUT);

  test("each declared variant, including none, reaches the wire as reasoning_effort", async () => {
    for (const variant of ["none", "low", "high", "max"] as const) {
      upstream.reset();
      const run = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}#${variant}`, "hi"]);
      const turn = lastRealTurn(upstream.requests);
      expect(run.code).toBe(0);
      expect(reasoningEffortOf(turn?.body)).toBe(variant);
    }
  }, UPSTREAM_TIMEOUT);

  test("an undeclared variant is rejected, not silently synthesized", async () => {
    const mark = upstream.requests.length;
    const run = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}#medium`, "hi"]);
    expect(run.code).not.toBe(0);
    expect(since(upstream, mark).length).toBe(0);
    expect(sanitizeEvidence(run.stderr)).toContain("Variant unavailable");
  }, UPSTREAM_TIMEOUT);

  test("empty declared ladder (variants: []) suppresses synthesis", async () => {
    const mark = upstream.requests.length;
    const run = await client.run(["run", "--standalone", "-m", `opencodex/${BRAVO}`, "hi"]);
    const turn = lastRealTurn(since(upstream, mark));
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBeUndefined();
    const rejected = await client.run(["run", "--standalone", "-m", `opencodex/${BRAVO}#high`, "hi"]);
    expect(rejected.code).not.toBe(0);
    expect(sanitizeEvidence(rejected.stderr)).toContain("Variant unavailable");
  }, UPSTREAM_TIMEOUT);

  test("unknown-capability model sends no reasoning controls and offers no variants", async () => {
    const mark = upstream.requests.length;
    const run = await client.run(["run", "--standalone", "-m", `opencodex/${DELTA}`, "hi"]);
    const turn = lastRealTurn(since(upstream, mark));
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBeUndefined();
    const rejected = await client.run(["run", "--standalone", "-m", `opencodex/${DELTA}#low`, "hi"]);
    expect(rejected.code).not.toBe(0);
  }, UPSTREAM_TIMEOUT);

  test("tool round-trip executes the tool and returns its result upstream", async () => {
    const project = client.freshProject("oc-tool");
    upstream.reset();
    // @opencode/cli's read tool names its input `path`.
    upstream.forceToolCall(ALPHA, { path: "note.txt" });
    const run = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}`, "read note.txt"], { project });
    expect(run.code).toBe(0);
    const withToolResult = upstream.requests.find(req => findToolMessages(req.body).length > 0);
    expect(withToolResult).toBeDefined();
    const toolMessage = findToolMessages(withToolResult!.body)[0];
    expect(String(toolMessage.content)).toContain("live-wire tool note 42");
  }, UPSTREAM_TIMEOUT);

  test("reasoning_content from turn one is replayed on the assistant message in turn two", async () => {
    const project = client.freshProject("oc-replay");
    upstream.reset();
    const first = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}`, "remember the passphrase"], { project });
    expect(first.code).toBe(0);
    const mark = upstream.requests.length;
    const second = await client.run(["run", "--standalone", "--continue", "-m", `opencodex/${ALPHA}`, "what was it"], { project });
    expect(second.code).toBe(0);
    const turn = lastRealTurn(since(upstream, mark));
    expect(rolesOf(turn?.body)).toContain("assistant");
    expect(assistantReasoningReplay(turn?.body, "reasoning_content")).toContain("REASONING");
  }, UPSTREAM_TIMEOUT);

  test("image attachment reaches the wire as an image_url content part", async () => {
    const project = client.freshProject("oc-image");
    upstream.reset();
    const run = await client.run(
      ["run", "--standalone", "-m", `opencodex/${ALPHA}`, "-f", "pixel.png", "describe the image"],
      { project },
    );
    expect(run.code).toBe(0);
    const turn = lastRealTurn(upstream.requests);
    expect(hasImagePart(turn?.body)).toBe(true);
  }, UPSTREAM_TIMEOUT);

  test("known image input with unknown tools preserves attachments without invalidating native variants", async () => {
    const imageClient = openCodeHarness(OC_BIN!, "unknown-tools-image");
    try {
      const models = liveWireExportModels().map(model => model.namespaced === ALPHA
        ? { ...model, supportsTools: undefined } : model);
      imageClient.writeGlobalConfig(buildClientConfig("opencode", { baseUrl: upstream.url, models }));
      const project = imageClient.freshProject("image");
      upstream.reset();
      const run = await imageClient.run(["run", "--standalone", "-m", `opencodex/${ALPHA}#max`, "-f", "pixel.png", "describe"], { project });
      expect(run.code).toBe(0);
      const turn = lastRealTurn(upstream.requests);
      expect(reasoningEffortOf(turn?.body)).toBe("max");
      expect(hasImagePart(turn?.body)).toBe(true);
    } finally { imageClient.cleanup(); }
  }, UPSTREAM_TIMEOUT);
});

// ===========================================================================
// Kilo (@kilocode/cli)
// ===========================================================================

describe.skipIf(!KILO_BIN)("kilo export live wire (opt-in: OCX_TEST_KILO_BIN)", () => {
  let upstream: LiveWireUpstream;
  let client: ReturnType<typeof kiloHarness>;

  beforeAll(() => {
    upstream = startLiveWireUpstream();
    client = kiloHarness(KILO_BIN!, "main");
    client.writeGlobalConfig(buildClientConfig("kilo", { baseUrl: upstream.url, models: liveWireExportModels() }));
  });

  afterAll(() => {
    client.cleanup();
    upstream.stop();
  });

  test("generated document matches the intended live-wire shape", () => {
    const generated = buildClientConfig("kilo", { baseUrl: upstream.url, models: liveWireExportModels() });
    expect(generated).toEqual(buildIntendedKiloDocument(upstream.url));
  }, 30_000);

  test("default selection sends the declared default effort", async () => {
    const mark = upstream.requests.length;
    const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "hi"]);
    const turn = lastRealTurn(since(upstream, mark));
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBe("low");
    expect(turn?.headers.authorization).toBe(`Bearer ${LIVE_WIRE_KEY_VALUE}`);
  }, UPSTREAM_TIMEOUT);

  test("declared variant map entries, including none, reach the wire as reasoning_effort", async () => {
    for (const variant of ["none", "low", "high", "max"] as const) {
      upstream.reset();
      const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "--variant", variant, "hi"]);
      const turn = lastRealTurn(upstream.requests);
      expect(run.code).toBe(0);
      expect(reasoningEffortOf(turn?.body)).toBe(variant);
    }
  }, UPSTREAM_TIMEOUT);

  test("an undeclared variant never produces an undeclared effort", async () => {
    upstream.reset();
    const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "--variant", "medium", "hi"]);
    const turn = lastRealTurn(upstream.requests);
    expect(run.code).toBe(0);
    // medium is not declared; the client falls back to the model's base options.
    expect(reasoningEffortOf(turn?.body)).toBe("low");
  }, UPSTREAM_TIMEOUT);

  test("all-disabled variant map suppresses synthesis for fixed-reasoning models", async () => {
    expect(Object.values(KILO_SUPPRESS_VARIANTS).every(v => v.disabled)).toBe(true);
    const mark = upstream.requests.length;
    const run = await client.run(["run", "-m", `opencodex/${BRAVO}`, "hi"]);
    const turn = lastRealTurn(since(upstream, mark));
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBeUndefined();
    for (const variant of ["high", "medium"]) {
      upstream.reset();
      const picked = await client.run(["run", "-m", `opencodex/${BRAVO}`, "--variant", variant, "hi"]);
      const pickedTurn = lastRealTurn(upstream.requests);
      expect(picked.code).toBe(0);
      expect(reasoningEffortOf(pickedTurn?.body)).toBeUndefined();
    }
  }, UPSTREAM_TIMEOUT);

  test("tool round-trip executes the tool and returns its result upstream", async () => {
    const project = client.freshProject("kilo-tool");
    upstream.reset();
    // @kilocode/cli's read tool names its input `filePath`.
    upstream.forceToolCall(ALPHA, { filePath: "note.txt" });
    const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "read note.txt"], { project });
    expect(run.code).toBe(0);
    const withToolResult = upstream.requests.find(req => findToolMessages(req.body).length > 0);
    expect(withToolResult).toBeDefined();
    const toolMessage = findToolMessages(withToolResult!.body)[0];
    expect(String(toolMessage.content)).toContain("live-wire tool note 42");
  }, UPSTREAM_TIMEOUT);

  test("reasoning_content from turn one is replayed on the assistant message in turn two", async () => {
    const project = client.freshProject("kilo-replay");
    upstream.reset();
    // Pin the session and title: --continue can select another session, and deferred
    // title-generation requests can otherwise masquerade as the final conversation turn.
    const first = await client.run([
      "run", "--format", "json", "--title", "live-wire reasoning replay",
      "-m", `opencodex/${ALPHA}`, "remember the passphrase",
    ], { project });
    expect(first.code).toBe(0);
    const sessionID = first.stdout.match(/"sessionID"\s*:\s*"([^"]+)"/)?.[1];
    expect(sessionID).toBeDefined();
    const mark = upstream.requests.length;
    const second = await client.run(["run", "--session", sessionID!, "-m", `opencodex/${ALPHA}`, "what was it"], { project });
    expect(second.code).toBe(0);
    const turn = lastRealTurn(since(upstream, mark));
    expect(rolesOf(turn?.body)).toContain("assistant");
    expect(assistantReasoningReplay(turn?.body, "reasoning_content")).toContain("REASONING");
  }, UPSTREAM_TIMEOUT);

  test("image attachment reaches the wire as an image_url content part", async () => {
    const project = client.freshProject("kilo-image");
    upstream.reset();
    // kilo's -f is an array flag and swallows trailing positionals, so the
    // message must come before the attachment.
    const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "describe the image", "-f", "pixel.png"], { project });
    expect(run.code).toBe(0);
    const turn = lastRealTurn(upstream.requests);
    expect(hasImagePart(turn?.body)).toBe(true);
  }, UPSTREAM_TIMEOUT);
});

// ===========================================================================
// Full chain: client -> real ocx proxy -> scripted upstream
// ===========================================================================

describe.skipIf(!OC_BIN || !KILO_BIN)("export live wire through the real proxy (opt-in)", () => {
  let upstream: LiveWireUpstream;
  let proxy: ReturnType<typeof startServer>;
  let proxyHome: string;
  let codexHome: ReturnType<typeof installIsolatedCodexHome> | undefined;
  let previousOpencodexHome: string | undefined;
  let ocClient: ReturnType<typeof openCodeHarness> | undefined;
  let kiloClient: ReturnType<typeof kiloHarness> | undefined;

  beforeAll(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    ocClient = openCodeHarness(OC_BIN!, "proxy");
    kiloClient = kiloHarness(KILO_BIN!, "proxy");
    upstream = startLiveWireUpstream();
    codexHome = installIsolatedCodexHome("ocx-live-wire-codex-");
    proxyHome = mkdtempSync(join(tmpdir(), "ocx-live-wire-proxy-"));
    process.env.OPENCODEX_HOME = proxyHome;
    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "ocxmock",
      providers: {
        ocxmock: {
          adapter: "openai-chat",
          baseUrl: upstream.url,
          allowPrivateNetwork: true,
          authMode: "key",
          apiKey: "upstream-key",
          models: ["alpha-ladder", "bravo-fixed", "delta-plain", "alpha-pinned"],
          modelPinnedReasoningEfforts: { "alpha-pinned": "high" },
          defaultModel: "alpha-ladder",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    proxy = startServer(0);
    const proxyBase = new URL(proxy.url).origin;
    const models = [...liveWireExportModels(), { ...liveWireExportModels()[0]!, namespaced: "ocxmock/alpha-pinned", id: "alpha-pinned" }];
    ocClient.writeGlobalConfig(buildClientConfig("opencode", { baseUrl: `${proxyBase}/v1`, models }));
    kiloClient.writeGlobalConfig(buildClientConfig("kilo", { baseUrl: `${proxyBase}/v1`, models }));
  });

  afterAll(async () => {
    ocClient?.cleanup();
    kiloClient?.cleanup();
    upstream?.stop();
    if (proxy) await drainAndShutdown(proxy, 5_000);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    codexHome?.restore();
    if (proxyHome) rmSync(proxyHome, { recursive: true, force: true });
  });

  test("opencode default effort and reasoning_content survive the proxy", async () => {
    upstream.reset();
    const run = await ocClient!.run(["run", "--standalone", "-m", `opencodex/${ALPHA}`, "hi"]);
    const turn = lastRealTurn(upstream.requests);
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBe("low");
    expect(String(turn?.body?.model)).toContain("alpha-ladder");
  }, UPSTREAM_TIMEOUT);

  test("opencode none variant survives the proxy", async () => {
    upstream.reset();
    const run = await ocClient!.run(["run", "--standalone", "-m", `opencodex/${ALPHA}#none`, "hi"]);
    const turn = lastRealTurn(upstream.requests);
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBe("none");
  }, UPSTREAM_TIMEOUT);

  test("kilo default effort and image survive the proxy", async () => {
    const project = kiloClient!.freshProject("proxy-image");
    upstream.reset();
    const run = await kiloClient!.run(["run", "-m", `opencodex/${ALPHA}`, "describe", "-f", "pixel.png"], { project });
    const turn = lastRealTurn(upstream.requests);
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(turn?.body)).toBe("low");
    expect(hasImagePart(turn?.body)).toBe(true);
  }, UPSTREAM_TIMEOUT);

  test.each(["opencode", "kilo"] as const)("%s variant selection cannot bypass an upstream effort pin", async kind => {
    upstream.reset();
    const run = kind === "opencode"
      ? await ocClient!.run(["run", "--standalone", "-m", "opencodex/ocxmock/alpha-pinned#none", "hi"])
      : await kiloClient!.run(["run", "-m", "opencodex/ocxmock/alpha-pinned", "--variant", "none", "hi"]);
    expect(run.code).toBe(0);
    expect(reasoningEffortOf(lastRealTurn(upstream.requests)?.body)).toBe("high");
  }, UPSTREAM_TIMEOUT);
});
