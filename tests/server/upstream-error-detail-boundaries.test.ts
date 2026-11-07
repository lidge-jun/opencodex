import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getRequestLogEntries, requestLogEntryFromPersistedUsage } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { readUsageEntries, usageLogPath } from "../../src/usage/log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
// All digits, so a Retry-After parser accepts it as a delay in seconds.
const NUMERIC_KEY = "73915028461739205817";
const saved = { home: process.env.OPENCODEX_HOME };
let home = "";
let status = 400;
let validationBody: unknown;
let upstream: ReturnType<typeof Bun.serve>;
let releaseSpendHome: (() => void) | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-error-detail-"));
  process.env.OPENCODEX_HOME = home;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.text();
    // The upstream repeats the credential it received, as some gateways do in error details.
    const echoed = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "") || req.headers.get("x-api-key") || "";
    const anthropic = new URL(req.url).pathname.endsWith("/messages");
    const error = { message: "invalid key " + echoed + "; retry in " + NUMERIC_KEY + " seconds", type: echoed, code: echoed, param: echoed };
    const body = validationBody ?? (anthropic ? { type: "error", error: { type: echoed, message: error.message } } : { error });
    return Response.json(body, { status, headers: { "retry-after": NUMERIC_KEY, "x-request-id": echoed, "request-id": echoed } });
  } });
  releaseSpendHome = acquireOwnedSpendHome();
});
afterAll(() => {
  upstream.stop(true);
  releaseSpendHome?.();
  if (saved.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved.home;
  if (home) removeTreeWithRetry(home);
});

function saveProviders(messagesNative: boolean) {
  const base = upstream.url.origin;
  saveConfig({
    port: 0, defaultProvider: "fxc",
    providers: {
      fxc: { adapter: "openai-chat", baseUrl: base + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"] },
      fxr: { adapter: "openai-responses", baseUrl: base + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"] },
      fxa: { adapter: "anthropic", baseUrl: base, authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["claude-x"] },
    },
    combos: { echo: { strategy: "failover", targets: [{ provider: "fxc", model: "m1" }, { provider: "fxr", model: "m1" }] },
      schema: { strategy: "failover", targets: [{ provider: "fxc", model: "m1" }] } },
    ...(messagesNative ? { protocols: { rollout: { managedMessagesNative: true } } } : {}),
  } as unknown as OcxConfig);
}

async function exchange(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const printed: string[] = [];
  const originals = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  for (const name of ["warn", "error", "log", "info"] as const) {
    console[name] = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  }
  let server: ReturnType<typeof startServer> | undefined;
  try {
    // Started inside the try, so the console is restored even if startup throws.
    server = startServer(0);
    const earlier = new Set(getRequestLogEntries().map(entry => entry.requestId));
    const res = await fetch(new URL(path, server.url), {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    await res.text();
    const responseHeaders = [...res.headers.entries()];
    // Poll until the request's row is live and persisted, so no absence check can pass on an empty read.
    const deadline = Date.now() + 5_000;
    let rows = getRequestLogEntries().filter(entry => !earlier.has(entry.requestId));
    while (rows.length === 0 || !rows.every(row => readUsageEntries().some(entry => entry.requestId === row.requestId))) {
      if (Date.now() > deadline) throw new Error(`no persisted request-log row for ${path} within 5s (live rows: ${rows.length})`);
      await Bun.sleep(20);
      rows = getRequestLogEntries().filter(entry => !earlier.has(entry.requestId));
    }
    return { status: res.status, responseHeaders, rows, printed };
  } finally {
    try { await server?.stop(true); } finally { Object.assign(console, originals); }
  }
}

const CASES = [
  { name: "native Chat Completions", path: "/v1/chat/completions", messagesNative: false,
    body: (stream: boolean) => ({ model: "fxc/m1", messages: [{ role: "user", content: "hi" }], stream }) },
  { name: "Responses passthrough", path: "/v1/responses", messagesNative: false,
    body: (stream: boolean) => ({ model: "fxr/m1", input: "hi", stream }) },
  { name: "combo route", path: "/v1/responses", messagesNative: false,
    body: (stream: boolean) => ({ model: "combo/echo", input: "hi", stream }) },
  { name: "native Messages", path: "/v1/messages", messagesNative: true,
    body: (stream: boolean) => ({ model: "fxa/claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream }) },
  { name: "Messages passthrough", path: "/v1/messages", messagesNative: false,
    body: (stream: boolean) => ({ model: "fxa/claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream }) },
] as const;

describe("upstream error details stay out of retry advice and request logs", () => {
  for (const scenario of CASES) {
    for (const stream of [false, true]) {
      for (const upstreamStatus of [400, 429, 503]) {
        test(scenario.name + " stream=" + stream + " upstream " + upstreamStatus, async () => {
          saveProviders(scenario.messagesNative);
          status = upstreamStatus;
          const before = existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8").length : 0;
          const result = await exchange(scenario.path, scenario.body(stream), { "anthropic-version": "2023-06-01" });
          expect(result.status).toBeGreaterThanOrEqual(400);
          // Retry advice is regenerated here; other relayed response headers have their own boundary.
          for (const [name, value] of result.responseHeaders) {
            expect(value).not.toContain(NUMERIC_KEY);
            if (name === "retry-after") {
              expect(value).not.toContain(PROVIDER_KEY);
              expect(value).toMatch(/^\d+$/);
              expect(Number(value)).toBeLessThanOrEqual(691200);
            }
          }
          expect(result.rows.length).toBeGreaterThan(0);
          const live = JSON.stringify(result.rows);
          expect(live).not.toContain(PROVIDER_KEY);
          expect(live).not.toContain(NUMERIC_KEY);
          const persisted = existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8").slice(before) : "";
          expect(persisted.length).toBeGreaterThan(0);
          expect(persisted).not.toContain(PROVIDER_KEY);
          expect(persisted).not.toContain(NUMERIC_KEY);
          const ids = new Set(result.rows.map(row => row.requestId));
          const hydratedRows = readUsageEntries().filter(entry => ids.has(entry.requestId)).map(requestLogEntryFromPersistedUsage);
          expect(hydratedRows.length).toBe(ids.size);
          const hydrated = JSON.stringify(hydratedRows);
          expect(hydrated).not.toContain(PROVIDER_KEY);
          expect(hydrated).not.toContain(NUMERIC_KEY);
          const printed = result.printed.join("\n");
          expect(printed).not.toContain(PROVIDER_KEY);
          expect(printed).not.toContain(NUMERIC_KEY);
        });
      }
    }
  }
});

describe("schema rejections preserve only closed operator diagnostics", () => {
  for (const [path, model] of [["/v1/chat/completions", "fxc/m1"], ["/v1/responses", "fxc/m1"], ["/v1/responses", "combo/schema"]]) {
    test(path + " " + model + " retains fields through live logs, disk and hydration", async () => {
      saveProviders(false);
      clearComboSelectionState("schema");
      clearComboTargetCooldowns("schema");
      status = 422;
      validationBody = { type: "invalid_request_error", detail: [
        { type: "extra_forbidden", loc: ["body", "max_completion_tokens"], msg: PROVIDER_KEY, input: "private fixture prompt", ctx: { key: PROVIDER_KEY } },
        { type: "union_tag_invalid", loc: ["body", "messages", 0, "role"], msg: "private fixture prompt", input: PROVIDER_KEY },
        { type: "extra_forbidden", loc: ["body", PROVIDER_KEY], input: PROVIDER_KEY },
      ] };
      try {
        const body = path.endsWith("completions")
          ? { model, messages: [{ role: "user", content: "hi" }] }
          : { model, input: "hi" };
        const result = await exchange(path, body);
        expect(result.status).toBe(422);
        const expected = { code: "provider_error", type: "invalid_request_error", validation: [
          { field: "max_completion_tokens", type: "extra_forbidden" }, { field: "messages.role", type: "union_tag_invalid" },
        ] };
        expect(result.rows[0]!.failureDetail).toEqual(expected);
        const disk = readUsageEntries().find(entry => entry.requestId === result.rows[0]!.requestId)!;
        expect(disk.failureDetail).toEqual(expected);
        expect(requestLogEntryFromPersistedUsage(disk).failureDetail).toEqual(expected);
        const recorded = JSON.stringify({ rows: result.rows, disk, printed: result.printed });
        expect(recorded).not.toContain(PROVIDER_KEY);
        expect(recorded).not.toContain("private fixture prompt");
      } finally { validationBody = undefined; }
    });
  }
});

test("translated validation bodies above the existing retention cap remain status-only", async () => {
  saveProviders(false);
  status = 422;
  validationBody = { detail: [{ type: "extra_forbidden", loc: ["body", "store"], input: "x".repeat(70 * 1024) }] };
  try {
    const result = await exchange("/v1/responses", { model: "fxc/m1", input: "hi" });
    expect(result.status).toBe(422);
    expect(result.rows[0]!.failureDetail?.validation).toBeUndefined();
  } finally { validationBody = undefined; }
});
