// One-shot gateway validation through the REAL adapter code path (Bun fetch).
// Run: bun scripts/dev-gateway-validate.ts   (dev-only, not shipped in the PR)
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildLlmIdentityHeaders, buildTraceHeaders } from "../src/adapters/zcode-start-plan";
import { transformStartPlanBody, userIdFromJwt } from "../src/adapters/zcode-start-plan/body-transform";
import { solveTraceless } from "../src/adapters/zcode-start-plan/captcha-solver";

const store = JSON.parse(readFileSync("/home/eros/.opencodex/auth.json", "utf8"));
const jwt = store["zcode-start-plan"].accounts[0].credential.access as string;
const userId = userIdFromJwt(jwt);

const param = await solveTraceless({ scene: "11xygtvd", region: "sgp", prefix: "no8xfe", timeoutMs: 30_000 });
writeFileSync("/tmp/captcha-param.txt", param);
console.error("minted", param.length);

const model = "GLM-5.3-Flash";
const body = transformStartPlanBody(
  JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "say OK" }] }),
  model,
  userId,
);

const res = await fetch("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", {
  method: "POST",
  redirect: "manual",
  headers: {
    ...buildLlmIdentityHeaders(),
    ...buildTraceHeaders(),
    authorization: `Bearer ${jwt}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "X-Aliyun-Captcha-Verify-Param": param,
    "X-Aliyun-Captcha-Verify-Region": "sgp",
  },
  body,
});
const text = await res.text();
console.log("HTTP", res.status);
console.log(text.slice(0, 600));
process.exit(res.ok ? 0 : 1);
