import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPrincipalIdOf, requireResponsesApiAuth, resolveApiAuth, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses/core";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { addFinalRequestLog, type RequestLogContext } from "../../src/server/request-log";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { cacheDiagnosticPath, observeInbound, tagCacheDiagnosticValue, type PrefixComparison } from "../../src/usage/cache-diagnostic";
import type { OcxConfig } from "../../src/types";
import { responsesSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Protocol = "responses" | "chat" | "messages";
type CredentialHeader = "authorization" | "x-opencodex-api-key" | "x-api-key";
interface DiagnosticRow {
  protocol: Protocol;
  continuation: { inbound: PrefixComparison; outbound: PrefixComparison };
}
const CALLER_A = "synthetic-diagnostic-caller-a";
const CALLER_B = "synthetic-diagnostic-caller-b";
const PROVIDER_KEY = "synthetic-diagnostic-provider";
const UNRELATED_BEARERS = ["synthetic-unrelated-bearer-one", "synthetic-unrelated-bearer-two"];
const FORGED_PRINCIPAL = "synthetic-forged-principal";
const HOOK = Symbol.for("opencodex.cache-diagnostic.v1");
type DiagnosticHook = { observeInbound: typeof observeInbound } & Record<string, unknown>;
const hookRegistry = globalThis as unknown as Record<symbol, DiagnosticHook>;
let registeredHook: DiagnosticHook;
let home: string;
let codex: IsolatedCodexHome;
let releaseSpend: () => void;
let previousHome: string | undefined;
let previousDebug: string | undefined;
let originalFetch: typeof fetch;
let networkCalls: number;
let inboundHeaders: Headers[];
let wireHeaders: Headers[];
let wireBodies: unknown[];
let principals: Set<string>;
let serializedContexts: string[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDebug = process.env.OPENCODEX_CACHE_DEBUG;
  home = mkdtempSync(join(tmpdir(), "ocx-cache-caller-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  codex = installIsolatedCodexHome("ocx-cache-caller-codex-");
  releaseSpend = acquireOwnedSpendHome();
  networkCalls = 0;
  inboundHeaders = [];
  wireHeaders = [];
  wireBodies = [];
  principals = new Set();
  serializedContexts = [];
  originalFetch = globalThis.fetch;
  const rejectNetwork = () => {
    networkCalls++;
    throw new Error("Network forbidden in cache caller isolation regression");
  };
  globalThis.fetch = Object.assign(async () => rejectNetwork(), { preconnect: rejectNetwork });
  // Observe the real bridge seam without replacing auth, handlers, adapters, or diagnostics.
  registeredHook = hookRegistry[HOOK]!;
  hookRegistry[HOOK] = { ...registeredHook, observeInbound(...args) {
    inboundHeaders.push(new Headers(args[1]));
    return registeredHook.observeInbound(...args);
  } };
});

afterEach(async () => {
  releaseSpend();
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  hookRegistry[HOOK] = registeredHook;
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDebug === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
  else process.env.OPENCODEX_CACHE_DEBUG = previousDebug;
  codex.restore();
  removeTreeWithRetry(home);
});

function config(): OcxConfig {
  return {
    port: 0, hostname: "0.0.0.0", defaultProvider: "fixture",
    apiKeys: [CALLER_A, CALLER_B].map((key, index) => ({
      id: `fixture-caller-${index}`, name: `Fixture caller ${index}`, key, createdAt: "2026-01-01",
    })),
    providers: { fixture: {
      adapter: "openai-responses", baseUrl: "https://cache-fixture.invalid/v1", authMode: "key",
      apiKey: PROVIDER_KEY, models: ["model"], liveModels: false,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        wireHeaders.push(new Headers(init?.headers));
        wireBodies.push(body);
        return Response.json(responsesSuccess("synthetic cache answer", "model"));
      }) as typeof fetch,
    } },
    claudeCode: { enabled: true },
  };
}

function rows(): DiagnosticRow[] {
  return readFileSync(cacheDiagnosticPath(), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

async function send(protocol: Protocol, cfg: OcxConfig, key: string, header: CredentialHeader,
  appended = false, extraHeaders: Record<string, string> = {}): Promise<string | undefined> {
  const messages = [{ role: "user", content: "synthetic shared prefix" },
    ...(appended ? [{ role: "assistant", content: "synthetic first answer" },
      { role: "user", content: "synthetic next turn" }] : [])];
  const body = { model: "fixture/model", stream: false, max_tokens: 32,
    ...(protocol === "responses" ? { input: messages } : { messages }) };
  const req = new Request(`http://localhost/v1/${protocol === "chat" ? "chat/completions" : protocol}`, {
    method: "POST", headers: { "content-type": "application/json", session_id: "synthetic-shared-session",
      [header]: header === "authorization" ? `Bearer ${key}` : key, ...extraHeaders }, body: JSON.stringify(body),
  });
  const admission = (protocol === "messages" ? resolveApiAuth : resolveResponsesApiAuth)(req, cfg);
  expect(admission).not.toBeNull();
  const principal = contextPrincipalIdOf(admission!);
  if (principal) principals.add(principal);
  const requestId = crypto.randomUUID();
  const start = Date.now();
  // These are the same log fields the HTTP ingress owns before invoking each handler.
  const log: RequestLogContext = { model: "", provider: "", inboundProtocol: protocol };
  const before = wireBodies.length;
  const turnAdmissionLease = tryAdmitTurn()!;
  expect(turnAdmissionLease).not.toBeNull();
  try {
    const response = protocol === "responses"
      ? await handleResponses(req, cfg, log, { admission: admission!, abortSignal: req.signal, turnAdmissionLease })
      : await (protocol === "chat" ? handleChatCompletions : handleClaudeMessages)(
        req, cfg, log, { requestId, start, admission: admission!, turnAdmissionLease });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("synthetic cache answer");
    // Responses' HTTP route owns finalization; Chat/Messages finalize their own bridge log.
    if (protocol === "responses") addFinalRequestLog(requestId, start, log, response.status);
    expect(wireBodies).toHaveLength(before + 1);
    expect(rows()).toHaveLength(before + 1);
    serializedContexts.push(JSON.stringify(log));
    return principal;
  } finally {
    turnAdmissionLease.release();
  }
}

function expectPrivacy(): void {
  const persisted = readFileSync(cacheDiagnosticPath(), "utf8");
  const contexts = serializedContexts.join("\n");
  const forwarded = JSON.stringify(wireHeaders.map(headers => Object.fromEntries(headers)));
  for (const secret of [CALLER_A, CALLER_B, ...UNRELATED_BEARERS, FORGED_PRINCIPAL, ...principals]) {
    expect(persisted).not.toContain(secret);
    expect(contexts).not.toContain(secret);
    expect(forwarded).not.toContain(secret);
    expect(JSON.stringify(wireBodies)).not.toContain(secret);
  }
  for (const principal of principals) {
    expect(persisted).not.toContain(tagCacheDiagnosticValue("caller-scope", principal));
    expect(contexts).not.toContain(tagCacheDiagnosticValue("caller-scope", principal));
    expect(forwarded).not.toContain(tagCacheDiagnosticValue("caller-scope", principal));
  }
  for (const headers of wireHeaders) {
    expect(headers.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(headers.has("x-opencodex-api-key")).toBe(false);
    expect(headers.has("x-api-key")).toBe(false);
    expect([...headers.keys()].some(name => /principal|caller|diagnostic/i.test(name))).toBe(false);
  }
  expect(networkCalls).toBe(0);
}

describe("cache diagnostic authenticated caller isolation", () => {
  for (const protocol of ["responses", "chat", "messages"] as const) {
    const acceptedHeaders: CredentialHeader[] = protocol === "messages"
      ? ["authorization", "x-opencodex-api-key", "x-api-key"] : ["authorization", "x-opencodex-api-key"];
    for (const header of acceptedHeaders) {
      test(`${protocol}: ${header} isolates interleaved callers and preserves identity across header aliases`, async () => {
        const cfg = config();
        const a = await send(protocol, cfg, CALLER_A, header);
        const b = await send(protocol, cfg, CALLER_B, header);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a).not.toBe(b);
        const alias = header === "authorization" ? "x-opencodex-api-key" : "authorization";
        expect(await send(protocol, cfg, CALLER_A, alias)).toBe(a);
        expect(await send(protocol, cfg, CALLER_A, header, true)).toBe(a);
        expect(await send(protocol, cfg, CALLER_B, alias)).toBe(b);
        for (const side of ["inbound", "outbound"] as const) {
          expect(rows().map(row => row.continuation[side].status)).toEqual([
            "first", "first", "equal", "append-only", "equal",
          ]);
        }
        expect(rows().map(row => row.protocol)).toEqual(Array(5).fill(protocol));
        if (protocol !== "responses") {
          expect(inboundHeaders).toHaveLength(5);
          for (const headers of inboundHeaders) expect(headers.has("authorization")).toBe(false);
        }
        expectPrivacy();
      });
    }

    test(`${protocol}: unrelated bearer and forged identity headers cannot override the admitted dedicated key`, async () => {
      const cfg = config();
      const forged = { authorization: `Bearer ${UNRELATED_BEARERS[0]}`,
        "x-opencodex-context-principal": FORGED_PRINCIPAL };
      const a = await send(protocol, cfg, CALLER_A, "x-opencodex-api-key", false, forged);
      const b = await send(protocol, cfg, CALLER_B, "x-opencodex-api-key", false, forged);
      expect(a).not.toBe(b);
      expect(await send(protocol, cfg, CALLER_A, "x-opencodex-api-key", false, {
        ...forged, authorization: `Bearer ${UNRELATED_BEARERS[1]}`,
      })).toBe(a);
      for (const side of ["inbound", "outbound"] as const) {
        expect(rows().map(row => row.continuation[side].status)).toEqual(["first", "first", "equal"]);
      }
      expectPrivacy();
    });

    if (protocol !== "messages") {
      test(`${protocol}: x-api-key alone remains rejected by its real ingress resolver`, () => {
        const req = new Request(`http://localhost/v1/${protocol === "chat" ? "chat/completions" : protocol}`, {
          method: "POST", headers: { "x-api-key": CALLER_A, session_id: "synthetic-shared-session" },
        });
        expect(resolveResponsesApiAuth(req, config())).toBeNull();
        expect(requireResponsesApiAuth(req, config())?.status).toBe(401);
        expect(wireBodies).toHaveLength(0);
        expect(inboundHeaders).toHaveLength(0);
        expect(networkCalls).toBe(0);
      });
    }

    test(`${protocol}: loopback admission never treats unverified credential headers as caller identity`, async () => {
      const cfg = { ...config(), hostname: "127.0.0.1" };
      for (const header of ["authorization", "x-opencodex-api-key", "x-api-key"] as const) {
        expect(await send(protocol, cfg, CALLER_A, header)).toBeUndefined();
        expect(await send(protocol, cfg, CALLER_A, header)).toBeUndefined();
      }
      for (const row of rows()) {
        expect(row.continuation.inbound.status).toBe("uncomparable");
        expect(row.continuation.outbound.status).toBe("uncomparable");
      }
      expectPrivacy();
    });
  }

  for (const protocol of ["chat", "messages"] as const) {
    test(`${protocol}: changing synthetic stored-main Authorization cannot replace the admission principal`, async () => {
      const cfg = config();
      const first = await send(protocol, cfg, CALLER_A, "authorization");
      const replacements = ["synthetic-bridge-main-one", "synthetic-bridge-main-two"];
      for (const access of replacements) {
        writeFileSync(join(codex.path, "auth.json"), JSON.stringify({
          tokens: { access_token: access, account_id: "synthetic-bridge-main-account" },
        }));
        expect(await send(protocol, cfg, CALLER_A, "authorization")).toBe(first);
      }
      expect(inboundHeaders.map(headers => headers.get("authorization"))).toEqual([
        null, ...replacements.map(access => `Bearer ${access}`),
      ]);
      for (const side of ["inbound", "outbound"] as const) {
        expect(rows().map(row => row.continuation[side].status)).toEqual(["first", "equal", "equal"]);
      }
      for (const access of replacements) expect(readFileSync(cacheDiagnosticPath(), "utf8")).not.toContain(access);
      expectPrivacy();
    });
  }
});
