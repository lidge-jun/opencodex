import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearKiroDeviceFlowsForTests, setKiroDeviceClockForTests, setKiroDevicePostForTests } from "../../src/oauth/kiro-device-login";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "./remove-tree";

export const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/example";
export const authorization = {
  deviceCode: "private-device-code", userCode: "ABCD-1234", verificationUri: "https://example.test/verify",
  expiresIn: 600, interval: 5,
};
export const socialAuthorization = {
  ...authorization, expiresInMilliseconds: 300_000, intervalInMilliseconds: 5_000,
};
export function response(body: Record<string, unknown>, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export function kiroDeviceFixture() {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-kiro-device-"));
  process.env.OPENCODEX_HOME = dir;
  let current = 1_000_000;
  setKiroDeviceClockForTests(() => current);
  return {
    setPost(post: (url: string, body: Record<string, unknown>) => Promise<Response>) { setKiroDevicePostForTests(post); },
    advance(ms: number) { current += ms; },
    async close() {
      clearKiroDeviceFlowsForTests();
      await flushConfigDirHardeningForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(dir);
    },
  };
}
