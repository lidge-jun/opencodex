import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubAdmission } from "../hub/src/admission";
import { HubAuth } from "../hub/src/auth";
import { HubBilling } from "../hub/src/billing";
import type { HubConfig } from "../hub/src/config";
import { HubDatabase } from "../hub/src/database";

const directories: string[] = [];
const SECRET = "test-only-admission-digest-secret-at-least-32-bytes";

function config(path: string): HubConfig {
  return {
    databasePath: path,
    digestSecret: SECRET,
    publicOrigin: "http://127.0.0.1:10400",
    hostname: "127.0.0.1",
    port: 0,
    allowRegistration: true,
    sessionTtlSeconds: 3600,
    development: true,
    trustLoopbackProxy: false,
    opencodexOrigin: "http://127.0.0.1:10100",
    internalAdmissionToken: "test-internal-opencodex-admission-token-32-bytes",
    requestCostUnits: 100,
    pricingVersion: "request-v1",
    upstreamTimeoutMs: 5_000,
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hubapi-admission-test-"));
  directories.push(directory);
  const path = join(directory, "hub.sqlite");
  const database = new HubDatabase(path);
  const auth = new HubAuth(database.db, SECRET, 3600);
  const billing = new HubBilling(database.db, SECRET);
  const admin = await auth.bootstrapAdmin("admin@example.com", "a sufficiently long admin password");
  const user = (await auth.register("user@example.com", "correct horse battery staple")).user;
  const apiKey = billing.createApiKey(user.id, "Test client");
  const batch = billing.createRechargeBatch(admin, { label: "Test credit", unitAmount: 1_000, quantity: 1 });
  return { database, auth, billing, user, apiKey, rechargeCode: batch.codes[0]!, config: config(path) };
}

function request(key: string, idempotencyKey = "request-attempt-0001", url = "http://hub.example/v1/responses"): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      Cookie: "must-not-forward=secret",
    },
    body: JSON.stringify({ model: "test-model", input: "private prompt" }),
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hub public data-plane admission", () => {
  test("reads the private model catalog through the internal admission credential and returns only bounded model ids", async () => {
    const context = await fixture();
    const seen: Request[] = [];
    const admission = new HubAdmission(context.config, context.billing, async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({
        object: "list",
        data: [
          { id: "coding", owned_by: "private-provider", credential: "must-not-pass" },
          { id: "vision" },
          { id: "coding" },
          { id: " ".repeat(3) },
          { id: 42 },
        ],
      });
    });
    expect(await admission.modelCatalog()).toMatchObject({ status: "available", models: ["coding", "vision"], upstreamStatus: 200 });
    expect(seen[0]?.url).toBe("http://127.0.0.1:10100/v1/models");
    expect(seen[0]?.headers.get("x-opencodex-api-key")).toBe(context.config.internalAdmissionToken);
    expect(seen[0]?.headers.get("authorization")).toBeNull();

    const oversized = new HubAdmission(context.config, context.billing, async () => new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(512 * 1024 + 1) },
    }));
    expect(await oversized.modelCatalog()).toMatchObject({ status: "unavailable", models: [], upstreamStatus: 200 });
    context.database.close();
  });

  test("fails a hostile oversized model catalog without awaiting its cancel hook", async () => {
    const context = await fixture();
    const admission = new HubAdmission(context.config, context.billing, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
      cancel() { return new Promise<void>(() => {}); },
    }), { headers: { "content-type": "application/json" } }));

    const result = await Promise.race([
      admission.modelCatalog(),
      new Promise<"timed_out">(resolve => setTimeout(() => resolve("timed_out"), 50)),
    ]);
    expect(result).not.toBe("timed_out");
    expect(result).toMatchObject({ status: "unavailable", models: [] });
    context.database.close();
  });

  test("rejects insufficient credit before contacting private OpenCodex", async () => {
    const context = await fixture();
    let calls = 0;
    const admission = new HubAdmission(context.config, context.billing, async () => {
      calls += 1;
      return new Response("unexpected");
    });
    const response = await admission.handle(request(context.apiKey.key));
    expect(response.status).toBe(402);
    expect(calls).toBe(0);
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(0);
    context.database.close();
  });

  test("strips public credentials, streams the response, and settles once on completion", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    const seen: Request[] = [];
    const admission = new HubAdmission(context.config, context.billing, async (input, init) => {
      seen.push(new Request(input, init));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          controller.enqueue(new TextEncoder().encode("data: done\n\n"));
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream", "Content-Encoding": "gzip", "Set-Cookie": "upstream=secret" } });
    });
    const response = await admission.handle(request(context.apiKey.key));
    expect(response.status).toBe(200);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 1_000, reservedUnits: 100, availableUnits: 900 });
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect(seen[0]?.headers.get("x-opencodex-api-key")).toBe(context.config.internalAdmissionToken);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toContain("data: done");
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 900, reservedUnits: 0, availableUnits: 900 });
    expect(context.billing.listLedger(context.user.id).filter(entry => entry.kind === "settlement")).toHaveLength(1);
    expect(context.billing.listRequests(context.user.id)[0]).toEqual(expect.objectContaining({
      routePath: "/v1/responses",
      modelAlias: "test-model",
      status: "settled",
      upstreamStatus: 200,
      terminalReason: "response_stream_completed",
    }));
    expect(context.billing.listRequests(context.user.id)[0]?.firstOutputAt).not.toBeNull();
    context.database.close();
  });

  test("releases failed upstream calls but charges an accepted stream cancelled by the client", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    const failed = new HubAdmission(context.config, context.billing, async () => new Response("failed", { status: 503 }));
    expect((await failed.handle(request(context.apiKey.key, "failure-attempt-0001"))).status).toBe(503);
    expect(context.billing.balance(context.user.id).balanceUnits).toBe(1_000);
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(0);

    const cancelled = new HubAdmission(context.config, context.billing, async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
    })));
    const response = await cancelled.handle(request(context.apiKey.key, "cancel-attempt-0001"));
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(100);
    await response.body?.cancel("client disconnected");
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 900, reservedUnits: 0, availableUnits: 900 });
    expect(context.billing.listRequests(context.user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "settled",
        upstreamStatus: 200,
        terminalReason: "response_stream_cancelled_after_acceptance",
      }),
      expect.objectContaining({
        status: "released",
        upstreamStatus: 503,
        terminalReason: "upstream_status_503",
      }),
    ]));
    context.database.close();
  });

  test("cancels the private upstream even when terminal accounting fails", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-cancel-failure-0001");
    let upstreamCancelled = false;
    const admission = new HubAdmission(context.config, context.billing, async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      cancel() { upstreamCancelled = true; },
    })));
    const response = await admission.handle(request(context.apiKey.key, "cancel-accounting-failure-0001"));
    context.billing.settleRequest = (() => { throw new Error("simulated_accounting_failure"); }) as typeof context.billing.settleRequest;

    await expect(response.body!.cancel("client disconnected")).rejects.toThrow("simulated_accounting_failure");
    expect(upstreamCancelled).toBe(true);
    context.database.close();
  });

  test("conservatively settles after upstream acceptance when local stream handoff fails", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    const upstream = new Response("accepted by private OpenCodex");
    const heldReader = upstream.body!.getReader();
    const admission = new HubAdmission(context.config, context.billing, async () => upstream);

    const response = await admission.handle(request(context.apiKey.key, "locked-stream-attempt-0001"));

    expect(response.status).toBe(502);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 900, reservedUnits: 0, availableUnits: 900 });
    expect(context.billing.listRequests(context.user.id)[0]).toEqual(expect.objectContaining({
      status: "settled",
      upstreamStatus: 200,
      terminalReason: "response_handoff_failed_after_acceptance",
    }));
    await heldReader.cancel();
    context.database.close();
  });

  test("never forwards a private upstream error body to the public client", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    const privateDiagnostic = `private prompt echoed with ${context.config.internalAdmissionToken}`;
    const admission = new HubAdmission(context.config, context.billing, async () => new Response(privateDiagnostic, {
      status: 503,
      headers: {
        "Content-Type": "text/plain",
        "Retry-After": "7",
        "Set-Cookie": "private-upstream=secret",
      },
    }));

    const response = await admission.handle(request(context.apiKey.key, "private-error-attempt-0001"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "upstream_rejected", requestId: expect.any(String) });
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 1_000, reservedUnits: 0, availableUnits: 1_000 });

    const modelsAdmission = new HubAdmission(context.config, context.billing, async () => new Response(privateDiagnostic, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    }));
    const modelsResponse = await modelsAdmission.handle(new Request("http://hub.example/v1/models", {
      headers: { Authorization: `Bearer ${context.apiKey.key}` },
    }));
    expect(modelsResponse.status).toBe(500);
    expect(await modelsResponse.json()).toEqual({ error: "upstream_rejected", requestId: expect.any(String) });
    context.database.close();
  });

  test("idempotency retry never forwards or settles twice", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    let calls = 0;
    const admission = new HubAdmission(context.config, context.billing, async () => {
      calls += 1;
      return new Response("ok");
    });
    const first = await admission.handle(request(context.apiKey.key, "stable-request-0001"));
    expect(await first.text()).toBe("ok");
    const second = await admission.handle(request(context.apiKey.key, "stable-request-0001"));
    expect(second.status).toBe(409);
    expect(calls).toBe(1);
    expect(context.billing.balance(context.user.id).balanceUnits).toBe(900);
    context.database.close();
  });

  test("rejects compressed and non-JSON bodies before reserving credit", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    let calls = 0;
    const admission = new HubAdmission(context.config, context.billing, async () => {
      calls += 1;
      return new Response("unexpected");
    });
    const compressed = request(context.apiKey.key, "compressed-attempt-0001");
    compressed.headers.set("Content-Encoding", "gzip");
    expect((await admission.handle(compressed)).status).toBe(415);
    const text = request(context.apiKey.key, "text-attempt-0001");
    text.headers.set("Content-Type", "text/plain");
    expect((await admission.handle(text)).status).toBe(415);
    expect(calls).toBe(0);
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(0);
    context.database.close();
  });

  test("cancels an oversized streamed request before buffering the remaining body", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-oversized-0001");
    let pulls = 0;
    let cancelled = false;
    let upstreamCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 10) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const oversized = new Request("http://hub.example/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.apiKey.key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "oversized-stream-attempt-0001",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const admission = new HubAdmission(context.config, context.billing, async () => {
      upstreamCalls += 1;
      return new Response("unexpected");
    });

    const response = await admission.handle(oversized);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(9);
    expect(upstreamCalls).toBe(0);
    expect(context.billing.balance(context.user.id).reservedUnits).toBe(0);
    context.database.close();
  });

  test("includes the query string in an idempotency fingerprint", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    let calls = 0;
    const admission = new HubAdmission(context.config, context.billing, async () => {
      calls += 1;
      return new Response("ok");
    });
    expect((await admission.handle(request(context.apiKey.key, "query-attempt-0001", "http://hub.example/v1/responses?mode=fast"))).status).toBe(200);
    expect((await admission.handle(request(context.apiKey.key, "query-attempt-0001", "http://hub.example/v1/responses?mode=safe"))).status).toBe(409);
    expect(calls).toBe(1);
    context.database.close();
  });

  test("times out a stalled upstream and releases the reservation", async () => {
    const context = await fixture();
    context.billing.redeem(context.user.id, context.rechargeCode, "fund-account-0001");
    context.config.upstreamTimeoutMs = 1_000;
    const admission = new HubAdmission(context.config, context.billing, async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return new Response("unreachable");
    });
    const response = await admission.handle(request(context.apiKey.key, "timeout-attempt-0001"));
    expect(response.status).toBe(502);
    expect(context.billing.balance(context.user.id)).toEqual({ balanceUnits: 1_000, reservedUnits: 0, availableUnits: 1_000 });
    context.database.close();
  });
});
