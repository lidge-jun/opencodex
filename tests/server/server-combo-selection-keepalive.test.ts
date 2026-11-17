import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import {
  COMBO_SELECTION_KEEPALIVE_INTERVAL_MS,
  COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS,
  type ComboSelectionKeepaliveClock,
} from "../../src/server/responses/combo-selection-keepalive";
import type { OcxConfig } from "../../src/types";

/**
 * #8326 through the real Responses entry point: a combo whose selection outlasts the threshold
 * answers with a keepalive head, and the outcome arrives in that stream. The threshold is driven
 * by a manual clock; loopback upstreams hold their answer until the test releases them.
 */
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const heldUpstreams: Array<() => void> = [];
const provider = comboProviderFactory(() => undefined);

function resetState(): void {
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-keepalive-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-keepalive-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  resetState();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  try {
    for (const release of heldUpstreams.splice(0)) release();
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    resetState();
  }
});

function manualClock(): ComboSelectionKeepaliveClock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) { const id = ++nextId; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(handle) { timers.delete(handle as number); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const failed = (id: string) => sse(
  { type: "response.created", response: { id, status: "in_progress" } },
  { type: "response.failed", response: { id, status: "failed", error: { type: "server_error", code: "upstream_server_error", message: "busy" } } },
);
const completed = (text: string) => sse({ type: "response.completed", response: {
  id: "resp-b", object: "response", status: "completed", model: "m2",
  output: [{ id: "msg_b", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
} });

/** Target a answers only after the test releases it; target b answers at once. */
function slowCombo(second: () => Response) {
  const arrived = gate();
  const release = gate();
  heldUpstreams.push(release.open);
  const serve = (handler: () => Response | Promise<Response>) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    servers.push(server);
    return `${server.url.toString().replace(/\/$/, "")}/v1`;
  };
  let holdA = true;
  const a = serve(async () => {
    if (holdA) { holdA = false; arrived.open(); await release.opened; }
    return failed("ra");
  });
  const b = serve(second);
  const config: OcxConfig = {
    port: 0,
    defaultProvider: "a",
    providers: { a: provider("openai-responses", a, "key-a"), b: provider("openai-responses", b, "key-b") },
    combos: { free: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
  };
  return { config, arrived, release, unhold: () => { holdA = false; } };
}

function streamingRequest(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
  });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const next = await reader.read();
  return next.done ? "<done>" : new TextDecoder().decode(next.value);
}

async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text;
    text += new TextDecoder().decode(next.value, { stream: true });
  }
}

describe("combo selection keepalive through handleResponses", () => {
  test("a fast all-targets failure keeps its HTTP status and body with the opt-in present", async () => {
    const baseline = slowCombo(() => failed("rb"));
    baseline.unhold();
    const plain = await handleResponses(streamingRequest(), baseline.config, { model: "", provider: "" });
    const plainText = await plain.text();
    resetState();
    const clock = manualClock();
    const optedIn = await handleResponses(streamingRequest(), baseline.config, { model: "", provider: "" }, {
      comboSelectionKeepalive: { clock },
    });
    expect(plain.status).toBeGreaterThanOrEqual(400);
    expect(optedIn.status).toBe(plain.status);
    expect(optedIn.headers.get("content-type")).toBe(plain.headers.get("content-type"));
    expect(await optedIn.text()).toBe(plainText);
  });

  test("a slow selection sends a 200 head and keepalives, then the next target's stream", async () => {
    const run = slowCombo(() => completed("slow backup"));
    const clock = manualClock();
    const pending = handleResponses(streamingRequest(), run.config, { model: "", provider: "" }, {
      comboSelectionKeepalive: { clock },
    });
    await run.arrived.opened;
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    const next = readChunk(reader);
    clock.advance(COMBO_SELECTION_KEEPALIVE_INTERVAL_MS);
    expect(await next).toBe(": keepalive\n\n");
    run.release.open();
    const rest = await readRest(reader);
    expect(rest).toContain("response.completed");
    expect(rest).toContain("slow backup");
    expect(rest).not.toContain("response.failed");
  });

  test("a slow selection that then fails everywhere ends in response.failed with the HTTP path's code", async () => {
    const baseline = slowCombo(() => failed("rb"));
    baseline.unhold();
    const plain = await handleResponses(streamingRequest(), baseline.config, { model: "", provider: "" });
    const plainError = (await plain.json() as { error: { code: string } }).error;
    resetState();

    const run = slowCombo(() => failed("rb"));
    const clock = manualClock();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const pending = handleResponses(streamingRequest(), run.config, logCtx, { comboSelectionKeepalive: { clock } });
    await run.arrived.opened;
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    run.release.open();
    const rest = await readRest(reader);
    const data = rest.split("\n").find(line => line.startsWith("data: "));
    expect(rest.startsWith("event: response.failed\n")).toBe(true);
    const event = JSON.parse(data!.slice("data: ".length)) as { type: string; response: { status: string; error: { code: string } } };
    expect(event.type).toBe("response.failed");
    expect(event.response.status).toBe("failed");
    expect(typeof plainError.code).toBe("string");
    expect(event.response.error.code).toBe(plainError.code);
    expect(logCtx.terminalHttpStatus).toBe(plain.status);
  });
});
