import { describe, expect, test } from "bun:test";
import {
  buildLlmIdentityHeaders,
  buildTraceHeaders,
  isCaptchaChallenge,
} from "../../src/adapters/zcode-start-plan";
import {
  buildStartPlanSystem,
  transformStartPlanBody,
  userIdFromJwt,
} from "../../src/adapters/zcode-start-plan/body-transform";
import {
  buildZcodeIdentityHeaders,
  buildZcodeTraceHeaders,
  isZcodePlanMeteredEndpoint,
} from "../../src/adapters/zcode-identity";

describe("zcode identity attribution eligibility", () => {
  test("plan-metered GLM send URLs qualify (resolved chat/responses paths + plan gateway)", () => {
    expect(isZcodePlanMeteredEndpoint("https://api.z.ai/api/coding/paas/v4/chat/completions")).toBe(true);
    expect(isZcodePlanMeteredEndpoint("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions")).toBe(true);
    expect(isZcodePlanMeteredEndpoint("https://open.bigmodel.cn/api/v1")).toBe(true);
    expect(isZcodePlanMeteredEndpoint("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")).toBe(true);
    expect(isZcodePlanMeteredEndpoint("https://api.z.ai/api/v1/responses")).toBe(true);
  });

  test("pay-as-you-go and unrelated send URLs do not qualify", () => {
    expect(isZcodePlanMeteredEndpoint("https://open.bigmodel.cn/api/paas/v4/chat/completions")).toBe(false);
    expect(isZcodePlanMeteredEndpoint("https://api.z.ai/api/paas/v4/chat/completions")).toBe(false);
    expect(isZcodePlanMeteredEndpoint("https://api.openai.com/v1/responses")).toBe(false);
    expect(isZcodePlanMeteredEndpoint(undefined)).toBe(false);
  });

  test("coding-plan scope adds the x-query-id/x-session-id pair; start-plan scope omits it", () => {
    const coding = buildZcodeTraceHeaders("coding-plan");
    const start = buildZcodeTraceHeaders("start-plan");
    expect(coding["x-query-id"]).toBeDefined();
    expect(coding["x-session-id"]).toBeDefined();
    expect(start["x-query-id"]).toBeUndefined();
    expect(start["x-session-id"]).toBeUndefined();
    for (const t of [coding, start]) {
      expect(t["x-zcode-session-type"]).toBe("main");
      expect(t["x-request-id"]).toBeDefined();
      expect(t["x-zcode-trace-id"]).toBeDefined();
    }
  });

  test("identity headers carry the ZCode client attribution", () => {
    const h = buildZcodeIdentityHeaders({ userAgentSuffix: "ai-sdk/anthropic/3.0.81" });
    expect(h["User-Agent"]).toMatch(/^ZCode\/3\.11\.2 ai-sdk\/anthropic\/3\.0\.81$/);
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["X-Title"]).toBe("Z Code@cli");
    const plain = buildZcodeIdentityHeaders();
    expect(plain["User-Agent"]).toBe("ZCode/3.11.2");
  });
});

describe("zcode-start-plan gateway body transform", () => {
  test("prepends official system blocks and merges the powered-by line into Environment", () => {
    const system = buildStartPlanSystem("caller prompt", "GLM-5.3");
    expect(system.length).toBe(4);
    expect(system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(system[2].text).toContain("# Environment");
    expect(system[2].text.endsWith("- You are powered by the model named GLM-5.3.")).toBe(true);
    expect(system[3]).toEqual({ type: "text", text: "caller prompt" });
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("string and block-array caller system both normalize after the official blocks", () => {
    expect(buildStartPlanSystem(undefined)[3]).toBeUndefined();
    const blocks = buildStartPlanSystem([{ type: "text", text: "keep" }, { type: "image" as never }]);
    expect(blocks[3]).toEqual({ type: "text", text: "keep" });
    // The unrecognized image entry is coerced (never dropped), so 3 official + 2 caller.
    expect(blocks.length).toBe(5);
  });

  test("the Claude Code identity block injected by the oauth-mode inner adapter is dropped", () => {
    const blocks = buildStartPlanSystem([
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: "text", text: "caller instruction" },
    ]);
    const texts = blocks.map(b => b.text);
    expect(texts).not.toContain("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(texts).toContain("caller instruction");
  });

  test("caller system blocks stay present after the official identity blocks (gateway contract)", () => {
    // The gateway REQUIRES the official ZCode blocks first (biz 3012 otherwise — extracted
    // from the desktop client). The caller's instructions must survive verbatim AFTER them;
    // this pins that the prepend never drops or truncates caller content.
    const blocks = buildStartPlanSystem("Always answer in Spanish.");
    expect(blocks.length).toBe(4);
    expect(blocks[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(blocks[3]).toEqual({ type: "text", text: "Always answer in Spanish." });
  });

  test("unrecognized caller system entries are coerced to text, never dropped", () => {
    const blocks = buildStartPlanSystem([{ type: "image", source: { type: "url" } }]);
    expect(blocks.length).toBe(4);
    expect(blocks[3].type).toBe("text");
    expect(blocks[3].text).toContain("image");
  });

  test("cache_control: strips stray markers, marks only the last message's last block", () => {
    const body = JSON.stringify({
      model: "GLM-5.3",
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
      ],
    });
    const out = JSON.parse(transformStartPlanBody(body, "GLM-5.3", undefined));
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
    expect(out.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(out.system[0].text).toContain("ZCode");
  });

  test("metadata.user_id injected from the JWT claim, other metadata preserved", () => {
    const body = JSON.stringify({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }], metadata: { foo: 1 } });
    const out = JSON.parse(transformStartPlanBody(body, "GLM-5.3", "user-123"));
    expect(out.metadata).toEqual({ foo: 1, user_id: "user-123" });
  });

  test("userIdFromJwt decodes the user_id claim", () => {
    const payload = Buffer.from(JSON.stringify({ user_id: "abc" })).toString("base64url");
    expect(userIdFromJwt(`x.${payload}.y`)).toBe("abc");
    expect(userIdFromJwt("not-a-jwt")).toBeUndefined();
  });
});

describe("zcode-start-plan identity headers", () => {
  test("mirrors the client's LLM companion header shape", () => {
    const headers = buildLlmIdentityHeaders();
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["User-Agent"]).toMatch(/^ZCode\/3\.11\.2 ai-sdk\/anthropic\/3\.0\.81$/);
    expect(headers["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(headers["X-Title"]).toBe("Z Code@cli");
    expect(headers["X-Release-Channel"]).toBe("production");
    expect(headers["X-Client-Language"].length).toBeGreaterThan(0);
    expect(headers["X-Client-Timezone"].length).toBeGreaterThan(0);
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    // The LLM path never carries a device id.
    expect(headers["X-Device-Mid"]).toBeUndefined();
  });
});

describe("zcode-start-plan trace headers", () => {
  test("fresh attribution ids per request", () => {
    const first = buildTraceHeaders();
    const second = buildTraceHeaders();
    expect(first["x-zcode-session-type"]).toBe("main");
    expect(first["x-request-id"]).not.toBe(second["x-request-id"]);
    expect(first["x-zcode-trace-id"]).not.toBe(second["x-zcode-trace-id"]);
    // start-plan requests carry no query/session attribution pair.
    expect(first["x-query-id"]).toBeUndefined();
    expect(first["x-session-id"]).toBeUndefined();
  });
});

describe("zcode-start-plan captcha challenge detection", () => {
  test("2xx responses are never challenges", () => {
    const headers = new Headers({ "x-aliyun-captcha-verify-param": "token" });
    expect(isCaptchaChallenge(200, headers, '{"code":3007}')).toBe(false);
  });

  test("response-header variant", () => {
    const headers = new Headers({ "x-aliyun-captcha-verify-param": "token" });
    expect(isCaptchaChallenge(400, headers, undefined)).toBe(true);
    const blank = new Headers({ "x-aliyun-captcha-verify-param": "  " });
    expect(isCaptchaChallenge(400, blank, undefined)).toBe(false);
  });

  test("in-body 3007 variant, both JSON spacings", () => {
    const headers = new Headers();
    expect(isCaptchaChallenge(400, headers, '{"code":3007,"msg":"captcha verify failed"}')).toBe(true);
    expect(isCaptchaChallenge(400, headers, '{"code": 3007, "msg": "captcha verify failed"}')).toBe(true);
    expect(isCaptchaChallenge(400, headers, '{"code":3001,"msg":"parameter error"}')).toBe(false);
    expect(isCaptchaChallenge(400, headers, undefined)).toBe(false);
  });
});
