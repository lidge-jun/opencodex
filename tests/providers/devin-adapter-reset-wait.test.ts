/**
 * The Devin adapter pins maxWaitMs to 0 when it calls the stated-reset retry
 * helper, so an admitted HTTP turn never holds shared capacity while sleeping
 * out a provider 429. The helper-level tests cannot see this: they pass their
 * own maxWaitMs. This file drives the real adapter and captures the option the
 * helper actually receives.
 */
import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let captured: { maxWaitMs?: number } | undefined;
mock.module("../../src/adapters/devin/cloud-direct/stated-reset-retry", () => ({
  streamChatEventsWithResetRetry: (_req: unknown, opts: { maxWaitMs?: number }) => {
    captured = opts;
    return (async function* () {})();
  },
  STATED_RESET_MAX_REPLAYS: 3,
  STATED_RESET_MAX_WAIT_MS: 1_800_000,
}));

const { createDevinAdapter } = await import("../../src/adapters/devin");
const { parseCatalogBuffer, setCachedCatalogForTests } = await import("../../src/adapters/devin/cloud-direct/catalog");
const { encodeMessage, encodeString, encodeVarintField } = await import("../../src/adapters/devin/cloud-direct/wire");
const { createTranslatorBudget } = await import("../../src/lib/translator-budget");

const apiKey = "ocx-devin-reset-wait-fixture";
const host = "https://server.codeium.com";
let home = "";
const previousHome = process.env.OPENCODEX_HOME;

function seed(): void {
  const buffer = Buffer.concat([encodeMessage(1, Buffer.concat([
    encodeString(1, "swe-2-high"),
    encodeString(22, "swe-2-high"),
    encodeVarintField(18, 262_000),
    encodeVarintField(4, 0),
  ]))]);
  setCachedCatalogForTests(parseCatalogBuffer(buffer, apiKey, host));
}

describe("devin adapter stated-reset wait", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-reset-wait-"));
    process.env.OPENCODEX_HOME = home;
    captured = undefined;
    seed();
  });
  afterEach(() => {
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  test("the adapter passes maxWaitMs 0 to the stated-reset helper", async () => {
    const adapter = createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host });
    const events: unknown[] = [];
    await adapter.runTurn!({
      modelId: "swe-2-high",
      stream: true,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      options: {},
    }, { headers: new Headers(), translatorBudget: createTranslatorBudget() },
    event => { events.push(event); });
    expect(captured).toBeDefined();
    expect(captured!.maxWaitMs).toBe(0);
  });
});
