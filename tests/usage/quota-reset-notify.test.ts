import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "../helpers/test-budget";
import { handleConfigCommand } from "../../src/cli/config-command";
import { validateConfigCandidate } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import {
  recordQuotaResetEvent,
  resetQuotaResetStoreForTests,
} from "../../src/quota/reset-seen-store";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import {
  resetQuotaResetNotifyCacheForTests,
  resolveQuotaResetNotify,
} from "../../src/quota/reset-notify-config";
import {
  resetQuotaResetActivationForTests,
  syncQuotaResetActivation,
} from "../../src/quota/reset-activation";
import { hasQuotaResetSink, setQuotaResetSink } from "../../src/quota/reset-observer";
import {
  clearAccountQuota,
  flushQuotaObservationsForTests,
  setAccountQuotaFromParsed,
} from "../../src/codex/quota";
import {
  deliverQuotaResetEvent,
  quotaResetPayloadForTests,
} from "../../src/quota/reset-sinks";

const NOW = Date.now();

function event(overrides: Partial<QuotaResetEvent> = {}): QuotaResetEvent {
  return {
    kind: "surprise",
    scope: "codex",
    accountTag: "9rhlw1hu",
    window: "weekly",
    percentBefore: 96,
    percentAfter: 4,
    previousResetAt: NOW + 3 * 86_400_000,
    resetAt: NOW + 7 * 86_400_000,
    detectedAt: NOW,
    key: "codex|9rhlw1hu|weekly|1",
    ...overrides,
  };
}

describe("the delivered payload carries no identity", () => {
  test("it names its fields rather than spreading the event", () => {
    // The internal idempotence `key` encodes the scope and account tag and has no business
    // crossing a webhook boundary. A spread would forward it, and would forward whatever the
    // detector gains next, silently.
    const payload = quotaResetPayloadForTests(event()) as Record<string, unknown>;

    expect(payload["key"]).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual([
      "accountTag",
      "detectedAt",
      "kind",
      "percentAfter",
      "percentBefore",
      "previousResetAt",
      "resetAt",
      "scope",
      "type",
      "window",
    ]);
  });

  test("absent numbers are omitted rather than sent as null", () => {
    const payload = quotaResetPayloadForTests({
      kind: "scheduled",
      scope: "anthropic",
      accountTag: "aaaaaaaa",
      window: "5h",
      detectedAt: NOW,
      key: "k",
    }) as Record<string, unknown>;

    expect("percentBefore" in payload).toBe(false);
    expect("resetAt" in payload).toBe(false);
  });
});

describe("webhook sink", () => {
  test("a fired event POSTs exactly one JSON body with no identifying data", async () => {
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        bodies.push(await req.text());
        return new Response("ok");
      },
    });
    try {
      const config = resolveQuotaResetNotify({
        enabled: true,
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        // Loopback is refused by default; a test receiver is the legitimate opt-in case.
        allowPrivateNetwork: true,
      });
      const results = await deliverQuotaResetEvent(event(), config);

      expect(results).toEqual([{ sink: "webhook", ok: true }]);
      expect(bodies).toHaveLength(1);

      const raw = bodies[0] ?? "";
      // The account key fed to the detector is an email on the codex path, so these three
      // assertions are the privacy contract that privacy:scan structurally cannot check: it
      // reads repository text, not runtime output.
      expect(raw).not.toContain("@");
      expect(raw).not.toContain("/Users/");
      expect(JSON.parse(raw)).not.toHaveProperty("accountId");
    } finally {
      server.stop(true);
    }
  });

  test("a loopback target is refused unless explicitly allowed", async () => {
    // An operator-supplied URL is an SSRF surface: this process reaches loopback services and
    // metadata endpoints a browser cannot.
    const config = resolveQuotaResetNotify({
      enabled: true,
      webhookUrl: "http://127.0.0.1:9/blocked",
    });
    expect(await deliverQuotaResetEvent(event(), config)).toEqual([
      { sink: "webhook", ok: false, reason: "blocked-destination" },
    ]);
  });

  test("a non-2xx response reports http-error and never throws", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    try {
      const config = resolveQuotaResetNotify({
        enabled: true,
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        allowPrivateNetwork: true,
      });
      expect(await deliverQuotaResetEvent(event(), config)).toEqual([
        { sink: "webhook", ok: false, reason: "http-error" },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("a webhook that redirects to loopback is refused", async () => {
    // The initial URL is validated; the redirect target is not. A public HTTPS endpoint can
    // 302 the POST to loopback or a metadata address, which would re-open the SSRF hole the
    // destination check just closed. Stubbed rather than served: this asserts the request
    // mode itself, and a real listener is unavailable under the sandbox.
    const seen: Array<RequestInit | undefined> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/" } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const config = resolveQuotaResetNotify({
        enabled: true,
        webhookUrl: "https://hooks.example.test/hook",
        allowPrivateNetwork: true,
      });
      expect(await deliverQuotaResetEvent(event(), config)).toEqual([
        { sink: "webhook", ok: false, reason: "blocked-destination" },
      ]);
      // The refusal must come from not following, not from a followed request that failed.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.redirect).toBe("manual");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a hanging receiver times out rather than blocking forever", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {
        // Never resolves: the timeout is the only thing that can end this request.
      }),
    });
    try {
      const config = resolveQuotaResetNotify({
        enabled: true,
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        allowPrivateNetwork: true,
        timeoutMs: 150,
      });
      expect(await deliverQuotaResetEvent(event(), config)).toEqual([
        { sink: "webhook", ok: false, reason: "timeout" },
      ]);
    } finally {
      server.stop(true);
    }
  });
});

describe("command sink", () => {
  test("the event JSON arrives on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cmd-"));
    const out = join(dir, "captured.json");
    const script = join(dir, "sink.ts");
    writeFileSync(script, [
      `const body = await Bun.stdin.text();`,
      `await Bun.write(${JSON.stringify(out)}, body);`,
    ].join("\n"));

    const config = resolveQuotaResetNotify({ enabled: true, command: ["bun", script] });
    const results = await deliverQuotaResetEvent(event(), config);

    expect(results).toEqual([{ sink: "command", ok: true }]);
    const captured = JSON.parse(await Bun.file(out).text()) as Record<string, unknown>;
    expect(captured["type"]).toBe("quota_reset");
    expect(captured["kind"]).toBe("surprise");
    // Pinned because a plain string throws ERR_INVALID_ARG_TYPE on Bun 1.4.0, so the encoded
    // form is load-bearing rather than stylistic.
    expect(captured["window"]).toBe("weekly");
  });

  test("a missing binary reports spawn-failed rather than throwing", async () => {
    const config = resolveQuotaResetNotify({
      enabled: true,
      command: ["ocx-no-such-binary-a7f3", "--go"],
    });
    expect(await deliverQuotaResetEvent(event(), config)).toEqual([
      { sink: "command", ok: false, reason: "spawn-failed" },
    ]);
  });

  test("a non-zero exit is reported without inspecting the output", async () => {
    const config = resolveQuotaResetNotify({ enabled: true, command: ["false"] });
    expect(await deliverQuotaResetEvent(event(), config)).toEqual([
      { sink: "command", ok: false, reason: "spawn-failed" },
    ]);
  });
});

describe("sinks are independent", () => {
  test("a blocked webhook does not stop the command from running", async () => {
    // The whole point of two sinks is redundancy; one failing must not suppress the other.
    const dir = mkdtempSync(join(tmpdir(), "ocx-both-"));
    const out = join(dir, "ran.txt");
    const script = join(dir, "sink.ts");
    writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, "ran");`);

    const config = resolveQuotaResetNotify({
      enabled: true,
      webhookUrl: "http://127.0.0.1:9/blocked",
      command: ["bun", script],
    });
    const results = await deliverQuotaResetEvent(event(), config);

    expect(results).toContainEqual({ sink: "webhook", ok: false, reason: "blocked-destination" });
    expect(results).toContainEqual({ sink: "command", ok: true });
    expect(await Bun.file(out).text()).toBe("ran");
  });
});

describe("kind filtering", () => {
  test("an excluded kind is not delivered at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-kind-"));
    const out = join(dir, "should-not-exist.txt");
    const script = join(dir, "sink.ts");
    writeFileSync(script, `await Bun.write(${JSON.stringify(out)}, "ran");`);

    const config = resolveQuotaResetNotify({
      enabled: true,
      kinds: ["surprise"],
      command: ["bun", script],
    });

    expect(await deliverQuotaResetEvent(event({ kind: "scheduled" }), config)).toEqual([]);
    expect(await Bun.file(out).exists()).toBe(false);

    expect(await deliverQuotaResetEvent(event({ kind: "surprise" }), config)).toEqual([
      { sink: "command", ok: true },
    ]);
  });
});

describe("enablement", () => {
  test("enabled with no sink resolves to off", () => {
    // An enabled subsystem with nowhere to deliver is a misconfiguration, and reporting it as
    // off is what keeps the default-OFF guarantee true rather than nearly true.
    expect(resolveQuotaResetNotify({ enabled: true }).enabled).toBe(false);
  });

  test("an absent section resolves to off", () => {
    expect(resolveQuotaResetNotify(undefined).enabled).toBe(false);
  });

  test("a disabled section with sinks configured stays off", () => {
    expect(resolveQuotaResetNotify({
      webhookUrl: "https://example.com/hook",
    }).enabled).toBe(false);
  });
});

describe("config integration", () => {
  test("private-network opt-in does not permit a cleartext webhook URL", () => {
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      quotaResetNotify: {
        enabled: true,
        webhookUrl: "http://127.0.0.1:9999/hook",
        allowPrivateNetwork: true,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("webhookUrl");
  });

  test("an invalid notify section is rejected by the write path", () => {
    // Live writes stay strict, so an operator is told rather than silently ignored.
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      quotaResetNotify: { enabled: "yes" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("quotaResetNotify");
  });

  test("an unknown key in the notify section is rejected, not ignored", () => {
    // `.strict()`: a typo that silently does nothing is worse than a rejected write, because the
    // operator believes they enabled something.
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      quotaResetNotify: { enabled: true, webhokUrl: "https://example.com/h" },
    });

    expect(result.ok).toBe(false);
  });

  test("a valid notify section passes the write path", () => {
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      quotaResetNotify: {
        enabled: true,
        kinds: ["surprise"],
        webhookUrl: "https://hooks.example.com/services/abc",
        pollSeconds: 0,
      },
    });

    expect(result.ok).toBe(true);
  });
});

describe("webhookUrl is treated as a credential", () => {
  test("ocx config show does not print it", async () => {
    // For Slack and Discord the URL IS the authorization: anyone holding it can post to the
    // channel. It matches none of the pre-existing secret-key patterns, so it had to be named
    // explicitly — before that, `config show` printed it and `config export` wrote it to disk.
    const home = mkdtempSync(join(tmpdir(), "ocx-redact-"));
    const secret = "https://hooks.slack.com/services/T00000/B00000/zzTOKENzz";
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
      quotaResetNotify: { enabled: true, webhookUrl: secret },
    }));

    const previousHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    const written: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
    try {
      expect(await handleConfigCommand(["show", "--json"])).toBe(0);
      const output = written.join("\n");
      // The whole point: the section is visible, the credential is not.
      expect(output).toContain("quotaResetNotify");
      expect(output).not.toContain("zzTOKENzz");
      expect(output).toContain("********");
    } finally {
      console.log = originalLog;
      if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = previousHome;
    }
  });
});

describe("GET /api/quota-resets", () => {
  function managementConfig(): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      },
    } as OcxConfig;
  }

  async function get(path: string, method = "GET"): Promise<Response | null> {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: { host: "localhost" },
    });
    return handleManagementAPI(req, new URL(req.url), managementConfig(), {
      saveConfigPreservingClaudeCode: () => {},
    });
  }

  test("it reports recorded events and whether detection is even on", async () => {
    // An isolated OPENCODEX_HOME, because the event ring is PERSISTED. Without this the store
    // hydrates from the developer's real state file and the count assertion below reflects
    // whatever that machine happens to hold — which is how this test first failed only when run
    // after the suites that write events.
    const home = mkdtempSync(join(tmpdir(), "ocx-route-"));
    const previousHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    try {
      resetQuotaResetStoreForTests();
      recordQuotaResetEvent(event({ key: "codex|tag|weekly|route" }));

      const response = await get("/api/quota-resets");
      expect(response?.status).toBe(200);

      const body = await response?.json() as { enabled: boolean; events: unknown[] };
      // `enabled` travels with the list because an empty list is otherwise ambiguous: an operator
      // debugging a missing notification cannot tell "nothing reset" from "never turned on".
      expect(body.enabled).toBe(false);
      expect(body.events).toHaveLength(1);
    } finally {
      resetQuotaResetStoreForTests();
      if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = previousHome;
    }
  });

  test("a non-numeric limit is rejected rather than silently defaulted", async () => {
    const response = await get("/api/quota-resets?limit=lots");
    expect(response?.status).toBe(400);
  });

  test.each([
    ["/api/quota-resets/extra", "GET"],
    ["/api/quota-resets-extra", "GET"],
    ["/api/quota-resets", "POST"],
  ])("%s %s is left to the rest of the chain", async (path, method) => {
    expect(await get(path!, method)).toBeNull();
  });
});

describe("activation is the single switch", () => {
  test("an absent config section installs no sink at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-inert-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
    }));

    const previousHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    try {
      resetQuotaResetNotifyCacheForTests();
      resetQuotaResetActivationForTests();
      setQuotaResetSink(null);

      expect(await syncQuotaResetActivation()).toBe(false);
      // No sink means observeQuotaSnapshot returns before it stores a baseline, which is what
      // makes "a default install executes no detection" true rather than nearly true.
      expect(hasQuotaResetSink()).toBe(false);
    } finally {
      setQuotaResetSink(null);
      resetQuotaResetActivationForTests();
      resetQuotaResetNotifyCacheForTests();
      if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = previousHome;
    }
  });

  test("a real rollover reaches a webhook once the section is enabled", async () => {
    // The end-to-end proof: config -> activation -> the production quota writer -> HTTP body.
    // Every earlier test exercises one link; this is the only one that shows the chain holds.
    const bodies: string[] = [];
    const received = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        bodies.push(await req.text());
        received.resolve();
        return new Response("ok");
      },
    });

    // Config requires HTTPS. Map only this reserved fixture URL at the transport
    // seam; keep the real HTTP receiver without disabling certificate checks.
    // This proves activation/delivery, not TLS integration.
    const webhookUrl = "https://hooks.example.test/activation";
    const receiverUrl = `http://127.0.0.1:${server.port}/hook`;
    const realFetch = globalThis.fetch;
    const dispatched: string[] = [];
    let receiveTimeout: ReturnType<typeof setTimeout> | undefined;

    const home = mkdtempSync(join(tmpdir(), "ocx-live-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
      quotaResetNotify: {
        enabled: true,
        webhookUrl,
        allowPrivateNetwork: true,
        // Passive-only: this asserts the live request path fires without any timer involved.
        pollSeconds: 0,
      },
    }));

    const previousHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    try {
      globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (input === webhookUrl) {
          dispatched.push(input);
          return realFetch(receiverUrl, init);
        }
        return realFetch(input, init);
      }, realFetch);
      resetQuotaResetNotifyCacheForTests();
      resetQuotaResetStoreForTests();
      resetQuotaResetActivationForTests();
      expect(await syncQuotaResetActivation()).toBe(true);

      // An email as the account key on purpose: the payload assertion below is what proves the
      // salted tag, not the identifier, is what crosses the wire.
      const expired = Date.now() - 60_000;
      setAccountQuotaFromParsed("operator@example.com", { weeklyPercent: 96, weeklyResetAt: expired });
      await flushQuotaObservationsForTests();

      setAccountQuotaFromParsed("operator@example.com", {
        weeklyPercent: 2,
        weeklyResetAt: Date.now() + 7 * 86_400_000,
      });
      await flushQuotaObservationsForTests();
      // Delivery is fire-and-forget; wait for the receiver, not a polling budget.
      await Promise.race([
        received.promise,
        new Promise<never>((_, reject) => {
          receiveTimeout = setTimeout(() => reject(new Error("quota webhook was not received")), INTERNAL_DEADLINE_MS);
        }),
      ]);

      expect(dispatched).toEqual([webhookUrl]);
      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
      expect(payload["type"]).toBe("quota_reset");
      expect(payload["kind"]).toBe("scheduled");
      expect(payload["window"]).toBe("weekly");
      expect(payload["percentBefore"]).toBe(96);
      expect(payload["percentAfter"]).toBe(2);
      expect(bodies[0]).not.toContain("operator@example.com");
      expect(bodies[0]).not.toContain("@");
      expect(bodies[0]).not.toContain("/Users/");
      expect(payload).not.toHaveProperty("accountId");
      expect(payload).not.toHaveProperty("key");
    } finally {
      if (receiveTimeout !== undefined) clearTimeout(receiveTimeout);
      globalThis.fetch = realFetch;
      setQuotaResetSink(null);
      resetQuotaResetActivationForTests();
      resetQuotaResetNotifyCacheForTests();
      clearAccountQuota();
      server.stop(true);
      if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = previousHome;
    }
  }, { timeout: SERVER_BUDGET_MS });
});
