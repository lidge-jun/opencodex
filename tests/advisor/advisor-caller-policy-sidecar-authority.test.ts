import { expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { captureAdmissionPolicy } from "../../src/server/capture-admission-policy";
import { readAdvisorAdmissionPolicy, registerAdvisorAdmissionPolicy, SIDECAR_ADMISSION_POLICY_HEADER, SIDECAR_INTERNAL_CAPABILITY_HEADER } from "../../src/server/advisor-admission-scope";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
import { describeImageRouted } from "../../src/vision/routed-describe";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

for (const state of ["missing", "released", "aborted", "forged", "live"] as const) {
  test(`routed helper policy authority: ${state}`, async () => {
    const release = acquireOwnedSpendHome();
    let sends = 0;
    const config: OcxConfig = { providers: { worker: {
      adapter: "openai-chat", models: ["m"], liveModels: false, apiKey: "fixture",
      baseUrl: "https://worker.test/v1", fetch: (async () => {
        sends++;
        return Response.json({ choices: [{ message: { content: "fixture" }, finish_reason: "stop" }] });
      }) as typeof fetch,
    } } };
    const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(config, undefined, { providers: ["other"], models: [] }));
    if (state === "released") registration.release();
    const controller = new AbortController();
    const aborted = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(config), controller.signal);
    if (state === "aborted") controller.abort();
    try {
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: {
          "content-type": "application/json",
          [SIDECAR_INTERNAL_CAPABILITY_HEADER]: state === "forged" ? "1" : internalCallCapability(),
          ...(state === "missing" ? {} : { [SIDECAR_ADMISSION_POLICY_HEADER]: state === "aborted" ? aborted.token : registration.token }),
        }, body: JSON.stringify({ model: "worker/m", messages: [{ role: "user", content: "fixture" }] }),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(state === "forged" ? 200 : 403);
      expect(sends).toBe(state === "forged" ? 1 : 0);
    } finally { registration.release(); aborted.release(); release(); }
  });
}

for (const outcome of ["success", "failure", "abort"] as const) {
  test(`routed helper releases its registration on ${outcome}`, async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let token: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      token = headers.get(SIDECAR_ADMISSION_POLICY_HEADER);
      expect(readAdvisorAdmissionPolicy(token, headers.get(SIDECAR_INTERNAL_CAPABILITY_HEADER))).toBeDefined();
      if (outcome === "abort") {
        controller.abort();
        expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeUndefined();
      }
      if (outcome !== "success") throw new Error("fixture connection failure");
      return Response.json({ choices: [{ message: { content: "fixture description" } }] });
    }) as typeof fetch;
    try {
      const result = await describeImageRouted("data:image/png;base64,aGVsbG8=", undefined, "fixture", "worker/m", {},
        { model: "worker/m", reasoning: "low", timeoutMs: 1000 }, controller.signal, "http://localhost", captureAdmissionPolicy({}));
      expect(Boolean(result.error)).toBe(outcome !== "success");
      expect(token).toBeTruthy();
      expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });
}
