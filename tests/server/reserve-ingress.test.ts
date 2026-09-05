import { describe, expect, test } from "bun:test";
import { isCodexReserveRequestEligible } from "../../src/codex/loopback-target";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { captureMainQuotaWriter } from "../../src/codex/main-account-cache";
import { getMainReserveAuthorization, isMainReserveAuthorizationLive } from "../../src/codex/reserve-availability";
import { ACCESS, ACCOUNT, EXTERNAL, PROXY_KEY, reserveIngressFixture, type Counters } from "../helpers/reserve-ingress-fixture";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

type Credential = "dedicated" | "bearer" | "external";
function headers(credential: Credential): Record<string, string> {
  if (credential === "bearer") return { authorization: `Bearer ${PROXY_KEY}` };
  return { "x-opencodex-api-key": PROXY_KEY,
    authorization: `Bearer ${credential === "external" ? EXTERNAL : ACCESS}`,
    "chatgpt-account-id": credential === "external" ? "external-fixture-account" : ACCOUNT };
}
function snapshot(counters: Counters) {
  return { wham: counters.wham, credential: counters.credential, tokenRead: counters.tokenRead, inference: counters.inference.length };
}
function delta(counters: Counters, before: ReturnType<typeof snapshot>) {
  return { wham: counters.wham - before.wham, credential: counters.credential - before.credential,
    tokenRead: counters.tokenRead - before.tokenRead, inference: counters.inference.length - before.inference };
}

describe("Reserve eligibility trusts receiving-listener admission", () => {
  test("default/off/client/missing admission stay off; credential source cannot become loopback", () => {
    const loopback = { source: "loopback" } as const;
    expect(isCodexReserveRequestEligible({}, loopback)).toBe(false);
    expect(isCodexReserveRequestEligible({ codexDesktopAuthless: false }, loopback)).toBe(false);
    expect(isCodexReserveRequestEligible({ codexDesktopAuthless: true, runtimeRole: "client" }, loopback)).toBe(false);
    expect(isCodexReserveRequestEligible({ codexDesktopAuthless: true }, undefined)).toBe(false);
    for (const source of ["dedicated", "bearer", "x-api-key"] satisfies Array<DataPlaneAdmission["source"]>) {
      expect(isCodexReserveRequestEligible({ codexDesktopAuthless: true }, { source })).toBe(false);
    }
    expect(isCodexReserveRequestEligible({ codexDesktopAuthless: true }, loopback)).toBe(true);
  });

  for (const transport of ["responses", "compact", "ws", "search"] as const) {
    for (const model of ["gpt-reserve", "main/gpt-reserve"]) {
      test(`${transport} ${model}: public localhost traffic stays public; credential-bearing sibling stays local`, async () => {
        const fixture = await reserveIngressFixture();
        try {
          // Both sockets are dialled from 127.0.0.1. Only the RECEIVING listener differs.
          for (const credential of ["dedicated", "bearer", "external"] as const) {
            const before = snapshot(fixture.counters);
            const result = await fixture.request("public", transport, model, headers(credential));
            const observed = delta(fixture.counters, before);
            // Search's pre-existing bearer-forwarding guard fires before compatibility.
            const searchAdmissionBearer = transport === "search" && credential === "bearer";
            expect(result.status).toBe(searchAdmissionBearer ? 401 : 200);
            expect(observed.wham).toBe(0);
            expect(observed.inference).toBe(searchAdmissionBearer ? 0 : 1);
            if (transport === "ws") expect(result.opened).toBe(true);
            if (model === "gpt-reserve" && credential !== "bearer") {
              expect(observed.credential).toBe(0);
              expect(fixture.counters.inference.at(-1)?.authorization)
                .toBe(`Bearer ${credential === "external" ? EXTERNAL : ACCESS}`);
            }
            fixture.assertConfigUnchanged();
          }
          for (const credential of ["dedicated", "bearer"] as const) {
            const before = snapshot(fixture.counters);
            const result = await fixture.request("local", transport, model, headers(credential));
            const observed = delta(fixture.counters, before);
            const search = transport === "search";
            // A bare Direct route's existing guard rejects our proxy secret before Reserve.
            // Exact-account routes use stored Pool credentials and do reach compatibility.
            const earlyBearerRefusal = credential === "bearer" && (search || model === "gpt-reserve");
            expect(result.status).toBe(earlyBearerRefusal ? 401 : search ? 400 : 429);
            expect(observed.wham).toBe(search || earlyBearerRefusal ? 0 : 1);
            expect(observed.inference).toBe(0);
            if (search) expect(observed.credential).toBe(0);
            if (transport === "ws") expect(result.opened).toBe(true);
            if (!search && !earlyBearerRefusal) expect(result.text).toContain("Reserve");
            fixture.assertConfigUnchanged();
          }
        } finally { await fixture.close(); }
      }, SERVER_BUDGET_MS);
    }
  }

  test("uncredentialed local Reserve acquires owned token; unmatched caller cannot acquire or infer", async () => {
    const fixture = await reserveIngressFixture();
    try {
      let before = snapshot(fixture.counters);
      const denied = await fixture.request("local", "responses", "gpt-reserve");
      expect(denied.status).toBe(429);
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 1, inference: 0 });
      expect(delta(fixture.counters, before).credential).toBeGreaterThan(0);
      before = snapshot(fixture.counters);
      const unmatched = await fixture.request("local", "responses", "gpt-reserve", headers("external"));
      expect(unmatched.status).toBe(429);
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, credential: 0, inference: 0 });
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test("authorized local Reserve reaches HTTP, compact and actual WS inference", async () => {
    const fixture = await reserveIngressFixture();
    try {
      fixture.allow();
      for (const transport of ["responses", "compact", "ws"] as const) {
        const before = snapshot(fixture.counters);
        const result = await fixture.request("local", transport, "main/gpt-reserve", headers("dedicated"));
        expect(result.status).toBe(200);
        expect(delta(fixture.counters, before).inference).toBe(1);
        expect(fixture.counters.inference.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
        expect(fixture.counters.inference.at(-1)?.model).toBe("gpt-reserve");
        if (transport === "ws") expect(result.opened).toBe(true);
      }
      expect(fixture.counters.wham).toBe(1);
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test("spoofed Host/forwarded headers and body admission/proof fields cannot select ingress", async () => {
    const fixture = await reserveIngressFixture();
    try {
      const spoof = { admission: { kind: "loopback", source: "loopback" }, source: "loopback",
        reserveAuthorization: { expiresAt: 4_000_000_000_000 }, codexDesktopAuthless: true };
      const before = snapshot(fixture.counters);
      const publicResult = await fixture.request("public", "responses", "gpt-reserve", {
        ...headers("external"), host: new URL(fixture.publicBase).host,
        "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost",
        "x-opencodex-admission-source": "loopback",
      }, spoof);
      expect(publicResult.status).toBe(200);
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, credential: 0, inference: 1 });
      const localBefore = snapshot(fixture.counters);
      const localResult = await fixture.request("local", "responses", "gpt-reserve", {
        ...headers("dedicated"), "x-opencodex-admission-source": "dedicated",
      }, { ...spoof, admission: { kind: "environment", source: "dedicated" }, codexDesktopAuthless: false });
      expect(localResult.status).toBe(429);
      expect(delta(fixture.counters, localBefore)).toMatchObject({ wham: 1, inference: 0 });
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test("a pending local permission read cannot contaminate concurrent public requests or shared config", async () => {
    const fixture = await reserveIngressFixture();
    const gate = fixture.hold();
    const local = fixture.request("local", "responses", "gpt-reserve", headers("dedicated"));
    try {
      await Promise.race([gate.started, local.then(() => { throw new Error("Local request skipped permission read"); })]);
      fixture.assertConfigUnchanged();
      const before = snapshot(fixture.counters);
      const results = await Promise.all([
        fixture.request("public", "responses", "gpt-reserve", headers("external")),
        fixture.request("public", "compact", "main/gpt-reserve", headers("dedicated")),
        fixture.request("public", "ws", "gpt-reserve", headers("external")),
      ]);
      expect(results.map(result => result.status)).toEqual([200, 200, 200]);
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, inference: 3 });
      fixture.assertConfigUnchanged();
      gate.release();
      expect((await local).status).toBe(429);
      expect(fixture.counters.wham).toBe(1);
      expect(fixture.counters.inference).toHaveLength(3);
      fixture.assertConfigUnchanged();
    } finally { gate.release(); await local.catch(() => undefined); await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test.each(["gpt-5.5", "keyed/gpt-reserve"])("ordinary/keyed %s is unchanged on both listeners", async model => {
    const fixture = await reserveIngressFixture();
    try {
      for (const listener of ["public", "local"] as const) {
        for (const transport of ["responses", "compact", "ws"] as const) {
          const before = snapshot(fixture.counters);
          expect((await fixture.request(listener, transport, model, headers("dedicated"))).status).toBe(200);
          expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, credential: 0, inference: 1 });
          expect(fixture.counters.inference.at(-1)?.authorization)
            .toBe(`Bearer ${model.startsWith("keyed/") ? "sk-ingress-fixture" : ACCESS}`);
        }
      }
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test.each(["chat", "messages"] as const)("translated %s: public has no Reserve WHAM; local allowlist refuses", async transport => {
    const fixture = await reserveIngressFixture();
    try {
      const before = snapshot(fixture.counters);
      const publicResult = await fixture.request("public", transport, "gpt-reserve", headers("dedicated"));
      expect(publicResult.status).toBe(200);
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, inference: 1 });
      const localBefore = snapshot(fixture.counters);
      const localResult = await fixture.request("local", transport, "gpt-reserve", headers("dedicated"));
      expect(localResult.status).toBe(404);
      expect(delta(fixture.counters, localBefore)).toEqual({ wham: 0, credential: 0, tokenRead: 0, inference: 0 });
      // This local 404 does NOT prove admission propagation inside the translated handler.
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);
});

describe("terminal routed vision helpers cannot spend Reserve", () => {
  const terminal = { "x-opencodex-vision-describe": "1" };

  test.each([
    ["chat", "openai/gpt-reserve"], ["chat", "main/gpt-reserve"],
    ["responses", "openai/gpt-reserve"], ["responses", "main/gpt-reserve"],
  ] as const)("%s %s refuses before credential enrichment", async (transport, model) => {
    // Chat is intentionally not served by the secondary listener; use an actual primary
    // loopback bind so this tests the handler, not the secondary listener's 404 allowlist.
    const fixture = await reserveIngressFixture({ primaryLoopback: true });
    try {
      fixture.allow(); // A permission denial must not accidentally make this test green.
      const before = snapshot(fixture.counters);
      const result = await fixture.request("public", transport, model, terminal);
      expect(result.status).toBe(400);
      expect(result.text).toContain("only available as a conversation model");
      expect(JSON.parse(result.text).error.type).toBe("invalid_request_error");
      expect(delta(fixture.counters, before)).toEqual({ wham: 0, credential: 0, tokenRead: 0, inference: 0 });
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test.each(["chat", "responses"] as const)("%s marker survives combo child reconstruction", async transport => {
    const fixture = await reserveIngressFixture({ primaryLoopback: true, configure: config => {
      config.combos = { helper: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-reserve" }] } };
    } });
    try {
      fixture.allow();
      const before = snapshot(fixture.counters);
      const result = await fixture.request("public", transport, "combo/helper", {
        ...headers("dedicated"), ...terminal,
      });
      expect(result.status).toBe(400);
      expect(result.text).toContain("only available as a conversation model");
      expect(JSON.parse(result.text).error.type).toBe("invalid_request_error");
      expect(delta(fixture.counters, before)).toMatchObject({ wham: 0, inference: 0 });
      // Chat may enrich the unresolved combo with main auth before the concrete child is
      // selected. Only the child's Reserve permission/inference work must remain zero.
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test.each(["chat", "responses"] as const)("%s keyed combo child is not refused because a later candidate is Reserve", async transport => {
    const fixture = await reserveIngressFixture({ primaryLoopback: true, configure: config => {
      config.combos = { helper: { strategy: "failover", targets: [
        { provider: "keyed", model: "gpt-reserve" }, { provider: "openai", model: "gpt-reserve" },
      ] } };
    } });
    try {
      fixture.allow();
      const result = await fixture.request("public", transport, "combo/helper", { ...headers("dedicated"), ...terminal });
      expect(result.status).toBe(200);
      expect(fixture.counters.wham).toBe(0);
      expect(fixture.counters.inference).toHaveLength(1);
      expect(fixture.counters.inference[0]).toMatchObject({ model: "gpt-reserve", authorization: "Bearer sk-ingress-fixture" });
      fixture.assertConfigUnchanged();
    } finally { await fixture.close(); }
  }, SERVER_BUDGET_MS);

  test("off-to-on during owned auth refuses a helper even after positive Reserve authorization", async () => {
    const fixture = await reserveIngressFixture({ primaryLoopback: true, configure: config => {
      config.codexDesktopAuthless = false;
    } });
    fixture.allow();
    const gate = fixture.holdCredential();
    const pending = fixture.request("public", "responses", "main/gpt-reserve", terminal);
    const observed = pending.then(
      result => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await Promise.race([gate.started, observed.then(() => { throw new Error("Request skipped awaited owned auth"); })]);
      expect(fixture.counters.credential).toBe(1);
      expect(fixture.counters.wham).toBe(0);
      fixture.setAuthless(true);
      gate.release();
      const outcome = await observed;
      if (outcome.status !== "fulfilled") throw outcome.error;
      expect(outcome.result.status).toBe(429); // Late dispatch policy refusal, not a transport failure.
      expect(outcome.result.text).toContain("only available as a conversation model");
      expect(JSON.parse(outcome.result.text).error.type).toBe("rate_limit_error");
      expect(fixture.counters.wham).toBe(1);
      expect(fixture.counters.inference).toEqual([]);
      const token = { accessToken: ACCESS, chatgptAccountId: ACCOUNT };
      const proof = await getMainReserveAuthorization({ token, writer: captureMainQuotaWriter(ACCOUNT),
        observeOrdinaryQuota() { throw new Error("Expected already cached positive proof, not another WHAM read"); },
      });
      expect(isMainReserveAuthorizationLive(proof, token)).toBe(true);
      expect(fixture.counters.wham).toBe(1);
      expect(fixture.counters.inference).toEqual([]);
    } finally { gate.release(); await observed; await fixture.close(); }
  }, SERVER_BUDGET_MS);

  for (const transport of ["chat", "responses"] as const) {
    test.each(["still-off", "conversation", "keyed"] as const)(`${transport} %s control retains inference`, async control => {
      const fixture = await reserveIngressFixture({ primaryLoopback: true, configure: config => {
        if (control === "still-off") config.codexDesktopAuthless = false;
      } });
      try {
        fixture.allow();
        const model = control === "keyed" ? "keyed/gpt-reserve" : "main/gpt-reserve";
        const result = await fixture.request("public", transport, model, control === "conversation" ? {} : terminal);
        expect(result.status).toBe(200);
        expect(fixture.counters.wham).toBe(control === "conversation" ? 1 : 0);
        expect(fixture.counters.inference).toHaveLength(1);
        expect(fixture.counters.inference[0]).toMatchObject({ model: "gpt-reserve",
          authorization: `Bearer ${control === "keyed" ? "sk-ingress-fixture" : ACCESS}` });
        fixture.assertConfigUnchanged();
      } finally { await fixture.close(); }
    }, SERVER_BUDGET_MS);
  }
});
