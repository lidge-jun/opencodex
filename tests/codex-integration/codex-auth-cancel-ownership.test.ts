import { describe, expect, test } from "bun:test";
import { handleCodexAuthLoginCancel } from "../../src/codex/auth-api/login-flow";
import { codexAuthLoginState } from "../../src/codex/auth-api/login-state";
import { cancelLoginFlow, clearLoginState, getLoginStatus, OAUTH_PROVIDERS, startLoginFlow } from "../../src/oauth";

const OLD_ID = "cancel-ownership-old";
const NEW_ID = "cancel-ownership-new";
const TERMINAL_ID = "cancel-ownership-terminal";

function cancel(body: unknown): Promise<Response> {
  return handleCodexAuthLoginCancel(new Request("http://127.0.0.1/api/codex-auth/login/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("Codex OAuth cancel ownership", () => {
  test("a stale flow cannot abort or expire the active controller", async () => {
    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    const signals: AbortSignal[] = [];
    OAUTH_PROVIDERS.chatgpt.login = async controller => {
      signals.push(controller.signal);
      controller.onAuth({ url: "about:blank" });
      return await new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
      });
    };

    try {
      await startLoginFlow("chatgpt", {}, { flowId: OLD_ID });
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(200);
      expect(signals[0]?.aborted).toBe(true);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("error");

      await startLoginFlow("chatgpt", {}, { flowId: NEW_ID });
      codexAuthLoginState.set(NEW_ID, { status: "pending", startedAt: Date.now() });
      codexAuthLoginState.set(TERMINAL_ID, { status: "error", startedAt: Date.now(), doneAt: Date.now() });
      const active = signals[1];
      expect(active).toBeDefined();

      for (const body of [{}, { flowId: "" }, { flowId: "  " }, { flowId: 42 }, null, [],
        { flowId: "unknown-flow" }, { flowId: TERMINAL_ID }]) {
        expect((await cancel(body)).status).toBe(400);
        expect(active?.aborted).toBe(false);
        expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("pending");
      }
      expect(codexAuthLoginState.has("unknown-flow")).toBe(false);
      expect(codexAuthLoginState.get(TERMINAL_ID)?.status).toBe("error");

      // A stale row can still say pending after its controller was replaced.
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(400);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");
      expect(active?.aborted).toBe(false);
      expect(getLoginStatus("chatgpt").done).toBe(false);

      const response = await cancel({ flowId: NEW_ID });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, cancelled: true });
      expect(active?.aborted).toBe(true);
      expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("error");
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");

      await startLoginFlow("chatgpt");
      expect(cancelLoginFlow("chatgpt")).toBe(true);
      expect(signals[2]?.aborted).toBe(true);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
      clearLoginState("chatgpt");
      codexAuthLoginState.delete(OLD_ID);
      codexAuthLoginState.delete(NEW_ID);
      codexAuthLoginState.delete(TERMINAL_ID);
    }
  });
});
